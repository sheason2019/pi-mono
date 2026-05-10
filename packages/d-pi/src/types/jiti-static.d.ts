declare module "jiti/static" {
	export interface Jiti {
		import<T = unknown>(specifier: string, options?: { default?: boolean }): Promise<T>;
	}

	export function createJiti(id: string, options?: unknown): Jiti;
	export function esmResolve(specifier: string, parent?: string): string;
}
