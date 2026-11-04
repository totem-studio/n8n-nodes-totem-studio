/** Explicit, bounded observation of one accepted durable operation. Never submits, retries or cancels a business effect. */
import { sleep, type IDataObject } from 'n8n-workflow';
interface OperationResponse { data: IDataObject }
export interface PublicApiOperationWaitOptions<T extends OperationResponse> {
	maxWaitSeconds: number;
	read: (operationId: string, remainingMilliseconds: number) => Promise<T>;
	/** Clock/timer boundary ports keep the deadline deterministic in tests. */
	now?: () => number;
	pause?: (milliseconds: number) => Promise<void>;
}
export interface PublicApiOperationObservation { status: 'interrupted'; code: 'observation_unavailable' }
export type PublicApiOperationWaitResult<T> = T & { observation?: PublicApiOperationObservation };
const pending = (status: unknown) => status === 'queued' || status === 'running';
function identity(data: IDataObject): { id: string; endpoint: string } {
	if (data.object !== 'operation' || typeof data.id !== 'string' || !/^op_[A-Za-z0-9]+$/u.test(data.id)
		|| typeof data.endpoint !== 'string' || !data.endpoint || typeof data.status !== 'string') throw new Error('Invalid operation observation');
	return { id: data.id, endpoint: data.endpoint };
}
export async function waitForPublicApiOperation<T extends OperationResponse>(initial: T, options: PublicApiOperationWaitOptions<T>): Promise<PublicApiOperationWaitResult<T>> {
	if (!Number.isInteger(options.maxWaitSeconds) || options.maxWaitSeconds < 1 || options.maxWaitSeconds > 60)
		throw new Error('Invalid operation wait duration');
	const original = identity(initial.data), now = options.now ?? Date.now;
	const pause = options.pause ?? sleep;
	const deadline = now() + options.maxWaitSeconds * 1_000;
	let latest = initial;
	while (pending(latest.data.status)) {
		const remaining = deadline - now();
		if (remaining <= 0) return latest;
		await pause(Math.min(1_000, remaining));
		if (now() >= deadline) return latest;
		try {
			const remainingMilliseconds = Math.max(1, Math.min(20_000, Math.floor(deadline - now())));
			const observed = await options.read(original.id, remainingMilliseconds), next = identity(observed.data);
			if (next.id !== original.id || next.endpoint !== original.endpoint) throw new Error('Operation observation changed identity');
			latest = observed;
		} catch {
			if (now() >= deadline) return latest;
			// This is a failed observation, never a new server-side operation state.
			return { ...latest, observation: { status: 'interrupted', code: 'observation_unavailable' } };
		}
	}
	return latest;
}
