/**
 * Scramjet 2.0.67-alpha.2 (the engine build this project ships) stringifies
 * the optional third argument of `history.pushState` / `history.replaceState`
 * before rewriting it:
 *
 *     const url = String(args[2]);
 *     if (url || url === "") args[2] = client.rewriteUrl(url);
 *
 * The URL argument is optional per the HTML spec — omitting it means "stay on
 * the current document" — but `String(undefined)` is the truthy string
 * `"undefined"`, so the engine rewrites it as a relative path and the SPA is
 * navigated to `<current route>/undefined`. A client router resolving that
 * path finds no match and renders the site's own in-app 404 (TikTok's
 * "Couldn't find this page"), even though the document loaded fine — the same
 * symptom a genuinely missing route produces. `null` has the same problem and
 * stringifies to `"null"`.
 *
 * Normalizing the missing/null URL to `""` — the spec's "current document
 * URL" — makes the call a genuine same-document navigation, so the pathname
 * stays the remote one and the proxied URL stays under the rewrite prefix
 * (which is what the engine's Referer/Origin mapping keys off of).
 */

type HistoryMethod = "pushState" | "replaceState";

const HISTORY_METHODS: HistoryMethod[] = ["pushState", "replaceState"];
const NORMALIZED = Symbol.for("nebula.history-url-normalized");

type HistoryPrototype = Record<HistoryMethod, unknown>;

type ProxiedWindow = {
	History?: { prototype?: Partial<HistoryPrototype> };
};

type InitPostProps = { window: Window };

type TapLike = {
	tap: (key: unknown, callback: (props: InitPostProps) => void) => void;
};

type EngineLike = { Tap?: TapLike };

type FrameLike = {
	hooks?: { init?: { post?: unknown } };
};

type ControllerLike = {
	frames?: FrameLike[];
	createFrame?: (...args: unknown[]) => FrameLike;
};

/**
 * Wrap this window's `pushState`/`replaceState` so an omitted or null URL is
 * forwarded to the engine as `""` instead of being stringified into a path.
 * Returns a restore callback, or null when there was nothing left to patch.
 */
function normalizeMissingHistoryUrl(win: Window): (() => void) | null {
	const proto = (win as ProxiedWindow).History?.prototype;
	if (!proto) return null;

	const restores: (() => void)[] = [];
	for (const method of HISTORY_METHODS) {
		const original = proto[method];
		if (typeof original !== "function") continue;
		if ((original as { [NORMALIZED]?: boolean })[NORMALIZED]) continue;

		const descriptor = Object.getOwnPropertyDescriptor(proto, method);
		if (!descriptor || !("value" in descriptor)) continue;

		const patched = function (
			this: History,
			state: unknown,
			title: string,
			url?: string | null
		) {
			const next = url === undefined || url === null ? "" : url;
			return Reflect.apply(original, this, [state, title, next]);
		};
		Object.defineProperty(patched, NORMALIZED, { value: true });
		Object.defineProperty(proto, method, { ...descriptor, value: patched });

		restores.push(() => {
			const current = Object.getOwnPropertyDescriptor(proto, method);
			if (current?.value === patched) Object.defineProperty(proto, method, descriptor);
		});
	}

	if (restores.length === 0) return null;
	return () => {
		for (const restore of restores.reverse()) restore();
	};
}

/**
 * Patch every proxied document this controller opens, including ones created
 * before this installer runs. Mirrors how the proxy context attaches to
 * frames: Scramjet dispatches `init.post` after it has installed its own
 * `History.prototype` wrappers, which is exactly when we can wrap them.
 *
 * @example
 * installHistoryCompat(window.controller);
 */
function installHistoryCompat(controller: unknown): () => void {
	const host = controller as ControllerLike | null;
	const engine = (globalThis as { $scramjet?: EngineLike }).$scramjet;
	if (
		!host ||
		typeof host.createFrame !== "function" ||
		!Array.isArray(host.frames) ||
		!engine?.Tap
	)
		return () => {};
	const tap = engine.Tap;

	const attached = new WeakSet<FrameLike>();
	const restores: (() => void)[] = [];
	const attach = (frame: FrameLike) => {
		const post = frame?.hooks?.init?.post;
		if (!post || attached.has(frame)) return;
		attached.add(frame);
		tap.tap(post, ({ window: win }) => {
			const restore = normalizeMissingHistoryUrl(win);
			if (restore) restores.push(restore);
		});
	};

	const originalCreate = host.createFrame;
	const createFrame = function (this: unknown, ...args: unknown[]) {
		const frame = Reflect.apply(originalCreate, this, args) as FrameLike;
		attach(frame);
		return frame;
	};
	host.createFrame = createFrame;
	for (const frame of host.frames) attach(frame);

	return () => {
		for (const restore of restores.splice(0).reverse()) restore();
		if (host.createFrame === createFrame) host.createFrame = originalCreate;
	};
}

export { installHistoryCompat, normalizeMissingHistoryUrl };
