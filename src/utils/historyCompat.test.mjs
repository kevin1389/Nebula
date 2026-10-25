import assert from "node:assert/strict";
import test from "node:test";
import { installHistoryCompat, normalizeMissingHistoryUrl } from "./historyCompat.ts";

const REMOTE_BASE = "https://www.tiktok.com/en_US/";

/**
 * Reproduces the installed engine's wrapper: Scramjet stringifies the optional
 * URL argument before rewriting it against the remote document URL.
 */
function enginePushState(calls) {
	return function (state, title, url) {
		const rewritten = new URL(String(url), REMOTE_BASE).pathname;
		calls.push(rewritten);
		return rewritten;
	};
}

function makeProxiedWindow() {
	const calls = [];
	const pushState = enginePushState(calls);
	const History = { prototype: { pushState, replaceState: pushState } };
	return { window: { History }, calls };
}

function makeEngine() {
	const taps = [];
	return {
		engine: { Tap: { tap: (key, callback) => taps.push(callback) } },
		dispatch: (props) => taps.forEach((callback) => callback(props))
	};
}

function makeFrame() {
	return { hooks: { init: { post: "post-key" } } };
}

function makeController() {
	const frames = [makeFrame()];
	return {
		frames,
		createFrame: () => {
			const frame = makeFrame();
			frames.push(frame);
			return frame;
		}
	};
}

function withEngine(run) {
	const engineApi = makeEngine();
	const previous = globalThis.$scramjet;
	globalThis.$scramjet = engineApi.engine;
	try {
		return run(engineApi);
	} finally {
		if (previous === undefined) delete globalThis.$scramjet;
		else globalThis.$scramjet = previous;
	}
}

test("unpatched engine turns a 2-argument pushState into an /undefined route", () => {
	const { window: win, calls } = makeProxiedWindow();
	win.History.prototype.pushState({ a: 1 }, "");
	assert.deepEqual(calls, ["/en_US/undefined"]);
});

test("the compat shim keeps a URL-less pushState on the remote pathname", () => {
	const { window: win, calls } = makeProxiedWindow();
	assert.equal(typeof normalizeMissingHistoryUrl(win), "function");
	win.History.prototype.pushState({ a: 1 }, "");
	assert.deepEqual(calls, ["/en_US/"]);
});

test("null and explicit undefined URLs are treated as current-document", () => {
	const { window: win, calls } = makeProxiedWindow();
	normalizeMissingHistoryUrl(win);
	win.History.prototype.replaceState({ a: 1 }, "", undefined);
	win.History.prototype.replaceState({ a: 1 }, "", null);
	assert.deepEqual(calls, ["/en_US/", "/en_US/"]);
});

test("real route changes still pass through untouched", () => {
	const { window: win, calls } = makeProxiedWindow();
	normalizeMissingHistoryUrl(win);
	win.History.prototype.pushState({ a: 1 }, "", "/discover");
	win.History.prototype.pushState({ a: 1 }, "", "https://www.tiktok.com/@user");
	assert.deepEqual(calls, ["/discover", "/@user"]);
});

test("patching is idempotent and restoring hands control back to the engine", () => {
	const { window: win, calls } = makeProxiedWindow();
	const restore = normalizeMissingHistoryUrl(win);
	assert.equal(typeof restore, "function");
	assert.equal(normalizeMissingHistoryUrl(win), null, "already patched windows are left alone");

	win.History.prototype.pushState({}, "");
	assert.deepEqual(calls, ["/en_US/"], "double wrapping must not change the outcome");

	restore();
	win.History.prototype.pushState({}, "");
	assert.deepEqual(calls, ["/en_US/", "/en_US/undefined"]);
});

test("attaches to frames created before and after the installer runs", () => {
	withEngine(({ dispatch }) => {
		const existing = makeProxiedWindow();
		const late = makeProxiedWindow();
		const controller = makeController();
		const dispose = installHistoryCompat(controller);

		dispatch({ window: existing.window });
		existing.window.History.prototype.pushState({}, "");
		assert.deepEqual(existing.calls, ["/en_US/"], "pre-existing frame was patched");

		controller.createFrame();
		dispatch({ window: late.window });
		late.window.History.prototype.pushState({}, "");
		assert.deepEqual(late.calls, ["/en_US/"], "frame created after install was patched");

		dispose();
		existing.window.History.prototype.pushState({}, "");
		assert.deepEqual(existing.calls, ["/en_US/", "/en_US/undefined"], "dispose restores the engine");
	});
});

test("is a no-op without a Scramjet engine or controller", () => {
	const previous = globalThis.$scramjet;
	delete globalThis.$scramjet;
	try {
		assert.equal(typeof installHistoryCompat(makeController()), "function");
		assert.equal(typeof installHistoryCompat(null), "function");
	} finally {
		if (previous === undefined) delete globalThis.$scramjet;
		else globalThis.$scramjet = previous;
	}
});
