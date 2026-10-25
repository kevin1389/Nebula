import { staticAssetBase } from './staticAssetLocation.ts';

export function serviceWorkerLocation(
	pageUrl: string,
	standaloneBase?: string
): { script: string; scope: string } {
	const base = staticAssetBase(pageUrl, standaloneBase);
	return { script: new URL('app-core.js', base).href, scope: base.pathname };
}
