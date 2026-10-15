// dsh-pylon-workbuddy — BROWSER half: the plugin's settings card.
//
// WHAT THIS IS
//   Six blocks on the plugin's own settings pages: the account rows (credits per
//   account), the model directory (tombstones vs live count), usage (with the
//   window start), the two rebuild buttons (additive-only 「重建清单」 next to the
//   destructive 「完全重建」), the manual 「签到」 button, and the credit-spending
//   「测试模型」 button. Every figure comes from the host route's `panel` answer;
//   nothing here invents a field.
//
// LOADING CONTRACT (the page loads this file, not we ourselves)
//   window.__ModuleLoader__.load({ id, factory: (require) => exports })
//     * The page appends this file as a CLASSIC <script>. Any `import`/`export`
//       statement is therefore a syntax error — hence the CJS factory form.
//     * `id` MUST equal the package.json `name` (dsh-client-modules keys the boot
//       graph by PACKAGE NAME and materializes with `factories.get(<pkg name>)`;
//       any other id throws `no registered factory for "<pkg>"`).
//     * `require` resolves PLATFORM SEED WORDS only (`react`, `react-dom`,
//       `react/jsx-runtime`) unless the package manifest lists the specifier.
//       This card needs React and nothing else ⇒ `dsh.client.inject: []`.
//     * The factory's return value is imported as a Cordis plugin module; the host
//       reads only `apply` and `inject`. Extra exports are inert, which is why the
//       pure helpers below are also exported under `__internals` for the offline
//       gate (tools/client-bundle-check.mjs) — it drives the shipped code, not a
//       copy of it.
//
// WHICH PATH: BOTH, `/wb2api/...` FIRST
//   The host route is registered twice on purpose — `/wb2api` (what the host
//   answers directly) and `/api/wb2api` (the desktop app's UI layer forwards only
//   `/api/*` to the host). A response that is NOT JSON never reached our handler
//   (the proxy's own 403 page, a 404, a dead transport), so the other prefix is
//   tried once and the winner is remembered for the rest of the page.
//   A BUSINESS REFUSAL IS NOT THAT: `{ok:false, detail}` is a perfectly good JSON
//   answer from our handler, so it is returned as-is and the other prefix is NOT
//   tried — otherwise every business error would cost two round trips.
//
// FOUR STATES, HONESTLY
//   loading / error / empty / ready are all rendered, the server's own `detail` is
//   printed verbatim, and no figure is fabricated: a missing number is printed as
//   `?`, never as a plausible-looking zero.
//
// TWO BUTTONS THAT COST SOMETHING
//   「签到」 talks to the UPSTREAM account (it is the only call that can change the
//   account's state), so it fires ONLY when clicked and its `checkin.note` sits
//   right next to the button. 「测试模型」 spends credits, so the browser asks twice
//   (a confirm dialog AND `confirm:true` in the body) — and a rejected confirmation
//   means no request is made at all.
//
// THE ONE BUTTON THAT DESTROYS SOMETHING
//   「完全重建（⚠️ 会覆盖你在模型页做的筛选）」 is the explicit exit for the
//   first-run dead end: 「重建清单」 is additive-only and, with no tombstone record
//   (a hand-written provider, a deleted state file), it deliberately adds NOTHING —
//   so there would otherwise be no way to pull the gateway's whole catalogue in.
//   The button's own label states the cost, its confirm dialog states it again, and
//   the answer lists the ids that were dropped. It sends `{action:"rebuild", reset:true}`
//   and nothing else; without that flag the host keeps the additive-only behaviour,
//   byte for byte.
window.__ModuleLoader__.load({
	id: "dsh-pylon-workbuddy",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		/** Must equal package.json's `name` (see the loading contract above). */
		const PKG = "dsh-pylon-workbuddy";
		/** The row id this bundle declares in cordis.patch.yml (`- id: pylon-workbuddy`). */
		const ROW_ID = "pylon-workbuddy";
		const SLOT_BUNDLE = "plugins.bundle.config";
		const SLOT_ROW = "plugins.row.config";
		/** Same band as the shipped sample cards (upstream trae card also uses 30). */
		const CARD_PRIORITY = 30;
		/**
		 * Both key spellings, one seat each:
		 *   `dsh-pylon-workbuddy`      — the installed package name (`pkg.name`), which
		 *                                is what the bundle page renders under;
		 *   `pylon-workbuddy`          — the cordis row id / the spelling the design
		 *                                documents use.
		 * A keyed slot only rejects a duplicate (key, priority), so these coexist; the
		 * renderer binds exactly one key per call, so at most one card is ever drawn.
		 */
		const BUNDLE_KEYS = [PKG, ROW_ID];
		const ROW_KEYS = [PKG + "#" + ROW_ID, ROW_ID + "#" + ROW_ID];

		/**
		 * Our own route prefixes, in the order they are tried. Both spellings belong
		 * to the SAME handler in src/index.ts; keep this list in sync with it.
		 */
		const ROUTE_BASE = ["/wb2api", "/api/wb2api"];
		/** Endpoints, relative to one route base. Frozen by the host contract. */
		const EP = { panel: "/panel", action: "/action" };
		/** How many rows of `usage.models` are printed before the list is summarised. */
		const MODEL_ROWS_SHOWN = 5;

		/* ─────────────────────────── 小工具 ─────────────────────────── */
		function msg(error) {
			return error instanceof Error ? error.message : String(error);
		}
		function isObj(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value);
		}
		/** The only way to read a server-provided reason. Never replaces it with our own. */
		function detailOf(payload) {
			return isObj(payload) && typeof payload["detail"] === "string" ? payload["detail"] : "";
		}
		function text(value) {
			return typeof value === "string" ? value : "";
		}
		function num(value) {
			if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
			// A number that already went through a `numText` (e.g. an account row built
			// once from the panel and then shaped again) stays a number, not a `?`.
			if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
			return undefined;
		}
		/**
		 * A number as it goes on screen. `?` (not `0`, not an empty cell) when the
		 * server did not give one: a fabricated zero reads as a measured fact.
		 */
		function numText(value) {
			const n = num(value);
			return n === undefined ? "?" : String(n);
		}
		function boolText(value, whenTrue, whenFalse) {
			return value === true ? whenTrue : whenFalse;
		}
		/** A duration in seconds, as a duration — never as a clock time. */
		function formatDuration(seconds) {
			const s = num(seconds);
			if (s === undefined || s < 0) return "未知";
			if (s < 60) return `${Math.floor(s)} 秒`;
			if (s < 3600) return `${Math.floor(s / 60)} 分`;
			if (s < 86400) return `${Math.floor(s / 3600)} 小时 ${Math.floor((s % 3600) / 60)} 分`;
			return `${Math.floor(s / 86400)} 天 ${Math.floor((s % 86400) / 3600)} 小时`;
		}
		/** Defensive list read: a non-array stays a zero-length list, not a crash. */
		function listOf(value) {
			return Array.isArray(value) ? value : [];
		}
		function plain(value) {
			return isObj(value) ? value : {};
		}
		function noop() {}

		/* ─────────────────── 端点调用（双前缀，记住赢家） ─────────────────── */
		/** The prefix that last answered with JSON. Module scope: one probe per page. */
		let preferredBase = ROUTE_BASE[0];

		/**
		 * POST/GET one host-route endpoint.
		 *
		 * Resolves `{ ok, payload, httpStatus }` where `ok` mirrors the server's own
		 * `ok` flag. Only a response that is not a JSON object (i.e. never reached our
		 * handler) moves on to the next prefix; a business refusal is returned as-is.
		 * Every tried path keeps its own HTTP status in the failure sentence, because
		 * "没有返回 JSON" alone cannot tell a fence rejection (403, possibly on ONE
		 * spelling only) apart from a proxy page, a 404, or a dead transport.
		 */
		async function callApi(endpoint, options) {
			const opts = options || {};
			const method = opts.method || "GET";
			const init = {
				method: method,
				credentials: "same-origin",
				cache: "no-store",
				headers: { accept: "application/json" }
			};
			if (opts.body !== undefined) {
				init.headers["content-type"] = "application/json";
				init.body = JSON.stringify(opts.body);
			}
			const tried = [preferredBase].concat(ROUTE_BASE.filter((base) => base !== preferredBase));
			const attempts = [];
			for (const base of tried) {
				let response;
				try {
					response = await fetch(base + endpoint, init);
				} catch (error) {
					attempts.push(`${base} →连接失败（${msg(error)}）`);
					continue;
				}
				const body = await response.text().catch(() => "");
				let payload;
				try {
					payload = body === "" ? undefined : JSON.parse(body);
				} catch {
					payload = undefined;
				}
				if (!isObj(payload)) {
					// 401/403 means the request DID reach something that decides access —
					// the host's fence, or the desktop app's proxy in front of it — and that
					// layer refused it. That is not the same claim as "没被转发".
					const verdict = response.status === 401 || response.status === 403 ? "被拒绝" : "没有返回 JSON";
					attempts.push(`${base} →HTTP ${response.status}（${verdict}）`);
					continue;
				}
				preferredBase = base;
				return { ok: payload["ok"] === true, payload: payload, httpStatus: response.status };
			}
			return {
				ok: false,
				payload: { ok: false, detail: `${method} ${endpoint} 失败，两条路都试过：${attempts.join("；")}` }
			};
		}

		/* ───────────────── 纯函数：把 panel 回答变成屏幕上的行 ───────────────── */
		/**
		 * One `credits.accounts` entry. The nickname is already masked by the server
		 * (it is the gateway's own field), so it is printed as received.
		 */
		function accountRow(account) {
			const row = plain(account);
			const nickname = text(row["nickname"]);
			const uid = text(row["uid"]);
			// A row that already carries a rendered `state` (the panel view shaped once,
			// then shaped again) keeps it instead of losing it to a re-read of the flags.
			const given = text(row["state"]);
			const tags = [];
			if (row["cooling"] === true) tags.push("冷却中");
			if (row["disabled"] === true) tags.push("已停用");
			return {
				id: uid !== "" ? uid : nickname,
				nickname: nickname !== "" ? nickname : uid !== "" ? uid : "（服务端没有给昵称）",
				realm: text(row["realm"]) !== "" ? text(row["realm"]) : "?",
				credits: numText(row["credits"]),
				state: given !== "" ? given : tags.join(" · ")
			};
		}
		/** `provider.lastOffered` (tombstones) next to `models.providerModelCount` (live). */
		function directoryLine(payload) {
			const root = plain(payload);
			const models = plain(root["models"]);
			const provider = plain(root["provider"]);
			const tomb = num(provider["lastOffered"]);
			const live = num(models["providerModelCount"]);
			const gat = num(models["gatewayTotal"]);
			const unknown = num(models["unknownPrice"]);
			const parts = [
				`网关目录 ${numText(gat)} 个`,
				`供应商清单 ${numText(live)} 个`,
				`配额记录（墓碑）${numText(tomb)} 个`,
				`未标价 ${numText(unknown)} 个`
			];
			let compare = "";
			if (tomb !== undefined && live !== undefined) {
				const delta = tomb - live;
				if (delta > 0) compare = `墓碑比实际多 ${delta} 个（你删掉的会留在这里，重建清单时不会复活）`;
				else if (delta < 0) compare = `墓碑比实际少 ${-delta} 个（网关新增了还没重建的）`;
				else compare = "墓碑与实际一致";
			}
			return {
				line: parts.join(" · "),
				compare: compare,
				ns: text(provider["ns"]),
				exists: provider["exists"] === true
			};
		}
		/**
		 * `usage`. `since` is printed even when it is missing, because "requests 0"
		 * on its own reads as "no usage at all" when it usually just means the
		 * gateway restarted and the window restarted with it.
		 */
		function usageView(payload) {
			const usage = plain(plain(payload)["usage"]);
			if (Object.keys(usage).length === 0) {
				return { phase: "empty", rows: [], models: [], note: "服务端没有返回用量字段" };
			}
			const models = listOf(usage["models"]);
			const rows = [
				`统计起点：${text(usage["since"]) !== "" ? text(usage["since"]) : "未提供（requests 0 不代表没有用量）"}`,
				`窗口内请求 ${numText(usage["requests"])} 次 · 额度消耗 ${numText(usage["credit"])}`,
				`插件已运行 ${formatDuration(usage["uptimeSec"])} · 记录中的模型 ${models.length} 个`
			];
			return {
				phase: "ready",
				rows: rows,
				models: models.slice(0, MODEL_ROWS_SHOWN).map((entry) => {
					const row = plain(entry);
					const id = text(row["id"]);
					return `${id !== "" ? id : JSON.stringify(row)} · 请求 ${numText(row["requests"])} 次`;
				}),
				modelsMore: models.length > MODEL_ROWS_SHOWN ? `（还有 ${models.length - MODEL_ROWS_SHOWN} 个没有列出）` : "",
				note: usage["enabled"] === true ? "" : "服务端说用量统计未启用"
			};
		}
		/** `checkin` — a description of the endpoint, never a claim about today. */
		function checkinView(payload) {
			const checkin = plain(plain(payload)["checkin"]);
			if (Object.keys(checkin).length === 0) {
				return { supported: false, note: "服务端没有返回签到信息" };
			}
			return { supported: checkin["supported"] === true, note: text(checkin["note"]) };
		}
		/** The whole `panel` answer as one plain view-model. Pure; the gate drives it. */
		function panelView(payload) {
			if (!isObj(payload)) return { phase: "empty", detail: "服务端没有返回面板数据" };
			const gateway = plain(payload["gateway"]);
			const credits = plain(payload["credits"]);
			const accounts = listOf(credits["accounts"]).map(accountRow);
			return {
				phase: "ready",
				detail: "",
				gateway: {
					reachable: gateway["reachable"] === true,
					origin: text(gateway["origin"]),
					healthy: numText(gateway["healthy"]),
					total: numText(gateway["total"])
				},
				credits: {
					total: numText(credits["total"]),
					accounts: accounts
				},
				directory: directoryLine(payload),
				usage: usageView(payload),
				checkin: checkinView(payload)
			};
		}

		/* ─────────────────────────── 动作（点一次才发生） ─────────────────────────── */
		/**
		 * 重建清单. Additive-only, and the confirmation says exactly that, because
		 * "只增不删" is the property that makes the button safe to press.
		 *
		 * `hint` comes from the server and is only ever non-empty when the server
		 * deliberately added NOTHING (no tombstone record): it explains why and points
		 * at the 完全重建 button below. Printing the reason next to the button is the
		 * whole difference between "the button is broken" and "this is by design".
		 */
		async function actRebuild(confirmFn) {
			const confirm = typeof confirmFn === "function" ? confirmFn : () => true;
			const accepted = confirm("重建清单：只增不删。\n只补上网关新增的模型；你自己删掉的不会复活。\n要现在重建吗？");
			if (accepted !== true) return { phase: "idle", detail: "", added: [], hint: "", serverDetail: "" };
			const answer = await callApi(EP.action, { method: "POST", body: { action: "rebuild" } });
			if (!answer.ok) {
				return {
					phase: "error",
					detail: detailOf(answer.payload) || "重建失败（服务端没有给出原因）",
					added: [],
					hint: "",
					serverDetail: ""
				};
			}
			const row = answer.payload;
			const parts = [];
			if (Array.isArray(row["added"])) parts.push(`新增 ${row["added"].length} 个`);
			if (typeof row["addedCount"] === "number") parts.push(`新增 ${row["addedCount"]} 个`);
			if (typeof row["keptCount"] === "number") parts.push(`保留 ${row["keptCount"]} 个`);
			if (typeof row["modelCount"] === "number") parts.push(`清单现有 ${row["modelCount"]} 个`);
			const detail = detailOf(row);
			return {
				phase: "ready",
				detail: parts.length > 0 ? parts.join(" · ") : detail !== "" ? detail : "服务端说重建完成（没有给出数字）",
				serverDetail: detail,
				added: listOf(row["added"]).map((id) => String(id)),
				hint: text(row["hint"])
			};
		}
		/**
		 * 完全重建 — the ONE destructive action of this card.
		 *
		 * It replaces the whole model list with the gateway catalogue, which means it
		 * overwrites the filtering the user did on the models page. That cost is
		 * therefore stated TWICE before anything leaves the browser: in the button's
		 * own label and again in this confirmation. A declined confirmation sends
		 * nothing at all.
		 *
		 * The request is `{action:"rebuild", reset:true}` — the `reset` flag is what
		 * makes the host overwrite; without it the host is additive-only.
		 */
		async function actReset(confirmFn) {
			const confirm = typeof confirmFn === "function" ? confirmFn : () => true;
			const accepted = confirm(
				"完全重建：⚠️ 会覆盖你在模型页做的筛选。\n" +
					"模型清单会以网关目录为准**整份重写**：你删掉的会回来，你手工加的会丢掉。\n" +
					"服务端会把丢掉的 id 逐个列出来。\n要现在完全重建吗？"
			);
			if (accepted !== true) return { phase: "idle", detail: "", written: [], dropped: [], serverDetail: "" };
			const answer = await callApi(EP.action, { method: "POST", body: { action: "rebuild", reset: true } });
			if (!answer.ok) {
				return {
					phase: "error",
					detail: detailOf(answer.payload) || "完全重建失败（服务端没有给出原因）",
					written: [],
					dropped: [],
					serverDetail: ""
				};
			}
			const row = answer.payload;
			const parts = [];
			if (typeof row["writtenCount"] === "number") parts.push(`写入 ${row["writtenCount"]} 个`);
			if (typeof row["addedCount"] === "number") parts.push(`新增 ${row["addedCount"]} 个`);
			if (typeof row["droppedCount"] === "number") parts.push(`丢掉 ${row["droppedCount"]} 个`);
			if (parts.length === 0 && typeof row["modelCount"] === "number") parts.push(`清单现有 ${row["modelCount"]} 个`);
			const detail = detailOf(row);
			return {
				phase: "ready",
				detail: parts.length > 0 ? parts.join(" · ") : detail !== "" ? detail : "服务端说完全重建完成（没有给出数字）",
				serverDetail: detail,
				written: listOf(row["written"]).map((id) => String(id)),
				dropped: listOf(row["dropped"]).map((id) => String(id))
			};
		}
		/** 签到. Fires ONLY from a click; there is no automatic trigger anywhere. */
		async function actCheckin() {
			const answer = await callApi(EP.action, { method: "POST", body: { action: "checkin" } });
			if (!answer.ok) {
				return { phase: "error", detail: detailOf(answer.payload) || "签到失败（服务端没有给出原因）" };
			}
			// "今日已领取" can only ever come from the server's answer.
			const detail = detailOf(answer.payload);
			return { phase: "ready", detail: detail !== "" ? detail : "服务端说签到完成（没有给出说明）" };
		}
		/**
		 * 测试模型 — the one action that SPENDS CREDITS. Two gates: the caller passes
		 * the user's confirmation in, and it goes into the body as `confirm:true`. A
		 * missing confirmation returns `needs-confirm` WITHOUT requesting anything.
		 */
		async function actTest(options) {
			const opts = options || {};
			if (opts.confirmed !== true) return { phase: "idle", detail: "", needsConfirm: true };
			const answer = await callApi(EP.action, { method: "POST", body: { action: "test", confirm: true } });
			if (!answer.ok) {
				return { phase: "error", detail: detailOf(answer.payload) || "测试失败（服务端没有给出原因）" };
			}
			const results = listOf(answer.payload["results"]).map((entry) => {
				const row = plain(entry);
				const id = text(row["id"]) !== "" ? text(row["id"]) : text(row["model"]);
				const verdict = text(row["verdict"]) !== "" ? text(row["verdict"]) : text(row["detail"]);
				return `${id !== "" ? id : "（没有模型 id）"} · ${verdict !== "" ? verdict : "服务端没有给出判定"}`;
			});
			const detail = detailOf(answer.payload);
			return {
				phase: "ready",
				detail: results.length > 0 ? "" : detail !== "" ? detail : "服务端说测试完成（没有给出判定）",
				lines: results
			};
		}

		/* ─────────────────────────── 样式 ─────────────────────────── */
		/** One stylesheet per package; the framework claims it by `data-plugin`. */
		const CARD_CSS_LABEL = PKG + "/WorkbuddySettingsCard.css";
		const CARD_CSS = [
			".dwb-card{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}",
			".dwb-head{display:flex;align-items:center;gap:8px;min-width:0}",
			".dwb-title{font-weight:600}",
			".dwb-badge{margin-left:auto;flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}",
			".dwb-block{display:flex;flex-direction:column;gap:4px;padding-top:6px;border-top:.5px solid var(--dsw-alias-border-l4)}",
			".dwb-blockTitle{font-size:11px;color:var(--dsw-alias-label-secondary)}",
			".dwb-line{display:flex;align-items:flex-start;gap:6px;min-width:0}",
			".dwb-key{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;min-width:64px}",
			".dwb-value{min-width:0;overflow-wrap:anywhere}",
			".dwb-num{font-variant-numeric:tabular-nums}",
			".dwb-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}",
			".dwb-btn{flex:none;padding:3px 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:6px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}",
			".dwb-btn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}",
			".dwb-dim{color:var(--dsw-alias-label-tertiary)}",
			".dwb-ok{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-primary))}",
			".dwb-warn{color:var(--dsw-alias-state-warn-primary,#b45309)}",
			".dwb-error{color:var(--dsw-alias-state-error-primary,#d92d20)}",
			".dwb-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px}",
			".dwb-list{margin:0;padding-left:16px}",
			".dwb-hint{font-size:11px;color:var(--dsw-alias-label-tertiary)}"
		].join("");
		if (typeof document !== "undefined" && typeof document.createElement === "function") {
			const tag = document.createElement("style");
			// The framework claims untagged sheets for the materializing package and later
			// removes them by `style[data-plugin=<pkg>]`. Naming both attributes keeps
			// that bookkeeping true and gives the sheet a label.
			tag.setAttribute("data-plugin", PKG);
			tag.setAttribute("data-plugin-css", CARD_CSS_LABEL);
			tag.textContent = CARD_CSS;
			document.head.appendChild(tag);
		}

		/* ─────────────────────────── 渲染 ─────────────────────────── */
		function line(key, value, cls) {
			return h(
				"div",
				{ className: "dwb-line" },
				key === undefined ? null : h("span", { className: "dwb-key" }, key),
				h("span", { className: "dwb-value" + (cls === undefined ? "" : " " + cls) }, value)
			);
		}
		/** The one renderer for all four phases. `text` is the server's own words. */
		function stateLine(phase, detail) {
			if (phase === "loading") return line(undefined, "读取中…", "dwb-dim");
			if (phase === "error") return line(undefined, detail === "" ? "失败（服务端没有给出原因）" : detail, "dwb-error");
			if (phase === "empty") return line(undefined, detail === "" ? "（空）" : detail, "dwb-dim");
			return null;
		}
		function block(title, children) {
			return h("div", { className: "dwb-block" }, h("div", { className: "dwb-blockTitle" }, title), children);
		}
		function button(label, onClick, disabled) {
			return h("button", { className: "dwb-btn", type: "button", onClick: onClick, disabled: disabled === true }, label);
		}
		/**
		 * Fill in the keys the view reads but the view-model may not carry yet.
		 *
		 * The hook mounts with its panel still `loading`, and the offline gate renders
		 * the initial view-model on purpose — so the gaps have to be filled in ONE
		 * place instead of defended against at every `vm.x.y` read.
		 */
		function shapedCredits(value) {
			const credits = plain(value);
			return {
				total: numText(credits["total"]),
				accounts: listOf(credits["accounts"]).map((account) => accountRow(account))
			};
		}
		function withDefaults(vm) {
			const source = plain(vm);
			const rebuild = plain(source["rebuild"]);
			const reset = plain(source["reset"]);
			const claim = plain(source["claim"]);
			const test = plain(source["test"]);
			const panel = plain(source["panel"]);
			return {
				panel: {
					phase: text(panel["phase"]) !== "" ? text(panel["phase"]) : "loading",
					detail: text(panel["detail"]),
					gateway: source["gateway"],
					credits: shapedCredits(source["credits"]),
					directory: isObj(source["directory"]) ? source["directory"] : { line: "", compare: "", ns: "", exists: false },
					usage: isObj(source["usage"]) ? source["usage"] : { phase: "loading", rows: [], models: [], modelsMore: "", note: "" },
					checkin: isObj(source["checkin"]) ? source["checkin"] : { supported: true, note: "" }
				},
				rebuild: {
					phase: text(rebuild["phase"]) !== "" ? text(rebuild["phase"]) : "idle",
					detail: text(rebuild["detail"]),
					added: listOf(rebuild["added"]),
					hint: text(rebuild["hint"]),
					serverDetail: text(rebuild["serverDetail"])
				},
				reset: {
					phase: text(reset["phase"]) !== "" ? text(reset["phase"]) : "idle",
					detail: text(reset["detail"]),
					written: listOf(reset["written"]),
					dropped: listOf(reset["dropped"]),
					serverDetail: text(reset["serverDetail"])
				},
				claim: {
					phase: text(claim["phase"]) !== "" ? text(claim["phase"]) : "idle",
					detail: text(claim["detail"])
				},
				test: {
					phase: text(test["phase"]) !== "" ? text(test["phase"]) : "idle",
					detail: text(test["detail"]),
					lines: listOf(test["lines"])
				},
				busy: text(source["busy"]),
				gateway: source["gateway"],
				credits: shapedCredits(source["credits"]),
				directory: isObj(source["directory"]) ? source["directory"] : { line: "", compare: "", ns: "", exists: false },
				usage: isObj(source["usage"]) ? source["usage"] : { phase: "loading", rows: [], models: [], modelsMore: "", note: "" },
				checkin: isObj(source["checkin"]) ? source["checkin"] : { supported: true, note: "" },
				onRebuild: typeof source["onRebuild"] === "function" ? source["onRebuild"] : noop,
				onReset: typeof source["onReset"] === "function" ? source["onReset"] : noop,
				onCheckin: typeof source["onCheckin"] === "function" ? source["onCheckin"] : noop,
				onTest: typeof source["onTest"] === "function" ? source["onTest"] : noop
			};
		}
		/** Rows common to the block and the gate: phase first, then the block's own lines. */
		function phaseRows(phase, detail, rows) {
			if (phase !== "ready") return [stateLine(phase, detail)];
			return rows;
		}
		function renderedLines(element) {
			const out = [];
			(function walk(node) {
				if (node === null || node === undefined || typeof node === "boolean") return;
				if (Array.isArray(node)) {
					for (const child of node) walk(child);
					return;
				}
				if (typeof node === "object" && node.props !== undefined) {
					out.push(node.props.className === undefined ? null : String(node.props.className));
					walk(node.props.children);
					return;
				}
				out.push(String(node));
			})(element);
			return out;
		}

		/**
		 * The card's whole surface.
		 *
		 * Pure by construction: it renders one plain view-model, which is what makes
		 * every state (loading / error / empty / ready) reachable from the offline
		 * check without a browser.
		 */
		function WorkbuddyCardView(input) {
			const vm = withDefaults(input);
			/* Everything below reads these, never `input`: a half-built view-model (the
			   mount state, a caller that passed one block) must not reach a bare read. */
			const panel = vm.panel;
			const directory = vm.directory;
			const usage = vm.usage;
			const checkin = vm.checkin;
			const rebuild = vm.rebuild;
			const reset = vm.reset;
			const claim = vm.claim;
			const test = vm.test;
			/* 头部：标题 + 网关徽标 */
			const head = [
				h("span", { className: "dwb-title" }, "workbuddy2api（自建供应商）")
			];
			const gateway = vm.gateway;
			if (isObj(gateway)) {
				head.push(
					h(
						"span",
						{ className: "dwb-badge" },
						`网关 ${gateway.reachable === true ? "可达" : "不可达"} · ${gateway.healthy}/${gateway.total}` +
							(text(gateway.origin) === "" ? "" : ` · ${gateway.origin}`)
					)
				);
			}

			/* ① 账号 */
			const accountRows = [];
			if (panel.phase !== "ready") {
				accountRows.push(stateLine(panel.phase, panel.detail));
			} else {
				accountRows.push(line("总额度", panel.credits.total, "dwb-num"));
				const accounts = panel.credits.accounts;
				if (accounts.length === 0) {
					accountRows.push(line(undefined, "本机没有看到任何账号", "dwb-dim"));
				}
				for (const account of accounts) {
					accountRows.push(
						line(
							account.nickname,
							`realm ${account.realm} · 额度 ${account.credits}` + (account.state === "" ? "" : ` · ${account.state}`),
							account.state === "" ? "dwb-num" : "dwb-warn"
						)
					);
				}
			}

			/* ② 模型目录 */
			const directoryRows = [];
			if (panel.phase !== "ready") {
				directoryRows.push(stateLine(panel.phase, panel.detail));
			} else {
				directoryRows.push(line("目录", panel.directory.line, "dwb-num"));
				if (panel.directory.ns !== "") {
					directoryRows.push(
						line("供应商", `${panel.directory.ns}${panel.directory.exists ? "" : "（配置里没有这一项）"}`)
					);
				}
				if (panel.directory.compare !== "") {
					directoryRows.push(line(undefined, panel.directory.compare, "dwb-dim"));
				}
			}

			/* ③ 用量 */
			const usageRows = [];
			if (usage.phase !== "ready") {
				usageRows.push(stateLine(usage.phase, usage.note));
			} else {
				for (const row of usage.rows) usageRows.push(line(undefined, row, "dwb-num"));
				for (const row of usage.models) usageRows.push(line(undefined, row, "dwb-dim"));
				if (usage.modelsMore !== "") usageRows.push(line(undefined, usage.modelsMore, "dwb-dim"));
				if (usage.note !== "") usageRows.push(line(undefined, usage.note, "dwb-warn"));
			}

			/* ④ 重建清单（只增不删）+ 完全重建（会覆盖筛选） */
			const rebuildRows = [
				line(undefined, "只补网关新增的模型；你删掉的不会复活。", "dwb-hint"),
				// First-run dead end, stated where it is felt: the additive button adds
				// NOTHING until the plugin has a record, and that is by design — the way
				// out is the second button right below.
				line(
					undefined,
					"（首次使用、或插件还没有「提供过哪些」的记录时，上面这个按钮**故意一个都不加** —— " +
						"它分不清「网关新增」和「你删掉的」，加错就是复活你删掉的模型。要把网关那份完整目录拉进来，用下面的「完全重建」。）",
					"dwb-hint"
				),
				h(
					"div",
					{ className: "dwb-actions" },
					button("重建清单", vm.onRebuild, vm.busy !== ""),
					rebuild.phase === "loading" ? stateLine("loading", "") : null,
					rebuild.phase === "error" ? stateLine("error", rebuild.detail) : null,
					rebuild.phase === "ready" ? line(undefined, rebuild.detail, "dwb-ok") : null
				)
			];
			if (rebuild.phase === "ready" && rebuild.added.length > 0) {
				rebuildRows.push(line(undefined, `新增：${rebuild.added.join("、")}`, "dwb-mono"));
			}
			if (rebuild.phase === "ready" && rebuild.serverDetail !== "") {
				rebuildRows.push(line(undefined, `服务端说明：${rebuild.serverDetail}`, "dwb-dim"));
			}
			// The server's own explanation for "I added nothing on purpose".
			if (rebuild.phase === "ready" && rebuild.hint !== "") {
				rebuildRows.push(line(undefined, rebuild.hint, "dwb-warn"));
			}
			// ── 完全重建：唯一的破坏性按钮。代价写在按钮上、再写在确认框里。 ──
			rebuildRows.push(
				line(undefined, "完全重建：忽略上面那条记忆，以网关目录为准整份重写模型清单。", "dwb-hint"),
				h(
					"div",
					{ className: "dwb-actions" },
					button("完全重建（⚠️ 会覆盖你在模型页做的筛选）", vm.onReset, vm.busy !== ""),
					reset.phase === "loading" ? stateLine("loading", "") : null,
					reset.phase === "error" ? stateLine("error", reset.detail) : null,
					reset.phase === "ready" ? line(undefined, reset.detail, "dwb-ok") : null
				)
			);
			if (reset.phase === "ready" && reset.dropped.length > 0) {
				rebuildRows.push(line(undefined, `丢掉：${reset.dropped.join("、")}`, "dwb-mono"));
			}
			if (reset.phase === "ready" && reset.written.length > 0) {
				rebuildRows.push(line(undefined, `写入：${reset.written.join("、")}`, "dwb-dim"));
			}
			if (reset.phase === "ready" && reset.serverDetail !== "") {
				rebuildRows.push(line(undefined, `服务端说明：${reset.serverDetail}`, "dwb-dim"));
			}

			/* ⑤ 签到（只有点了才发请求；旁边的 note 说明它直连上游） */
			const checkinRows = [
				h(
					"div",
					{ className: "dwb-actions" },
					button(vm.busy === "checkin" ? "签到中…" : "签到", vm.onCheckin, vm.busy !== "" || checkin.supported !== true),
					checkin.supported !== true ? h("span", { className: "dwb-hint" }, "服务端说这个网关不支持签到") : null
				),
				line(undefined, checkin.note === "" ? "（服务端没有给出签到说明）" : checkin.note, "dwb-hint"),
				claim.phase === "loading" ? stateLine("loading", "") : null,
				claim.phase === "error" ? stateLine("error", claim.detail) : null,
				claim.phase === "ready" ? line("服务端状态", claim.detail, "dwb-ok") : null
			];

			/* ⑥ 模型测试（会花额度：按钮本身就是那把锁） */
			const testRows = [
				line(undefined, "⚠️ 测试会向真实上游发一次最小请求，会花掉少量额度。", "dwb-warn"),
				h(
					"div",
					{ className: "dwb-actions" },
					button(vm.busy === "test" ? "测试中…" : "测试模型（会花额度）", vm.onTest, vm.busy !== ""),
					test.phase === "error" ? stateLine("error", test.detail) : null,
					test.phase === "ready" && test.lines.length === 0 ? line(undefined, test.detail, "dwb-ok") : null
				)
			];
			if (test.phase === "ready" && test.lines.length > 0) {
				testRows.push(
					h(
						"ul",
						{ className: "dwb-list" },
						test.lines.map((row, index) => h("li", { key: String(index), className: "dwb-mono" }, row))
					)
				);
			}

			return h(
				"div",
				{ className: "dwb-card", "data-plugin-card": PKG },
				h("div", { className: "dwb-head" }, head),
				block("① 账号", accountRows),
				block("② 模型目录", directoryRows),
				block("③ 用量", usageRows),
				block("④ 重建清单", rebuildRows),
				block("⑤ 签到", checkinRows),
				block("⑥ 模型测试", testRows)
			);
		}

		/**
		 * The view-model's initial value, in ONE place.
		 *
		 * The hook seeds each block from this and the offline gate builds every
		 * scenario from it too, so the card's four states cannot drift away from the
		 * states the offline check exercises.
		 */
		function emptyState() {
			return {
				panel: { phase: "loading", detail: "" },
				rebuild: { phase: "idle", detail: "", added: [], hint: "", serverDetail: "" },
				reset: { phase: "idle", detail: "", written: [], dropped: [], serverDetail: "" },
				claim: { phase: "idle", detail: "" },
				test: { phase: "idle", detail: "", lines: [] },
				busy: ""
			};
		}

		/**
		 * The card, wired to the host.
		 *
		 * One `useState` per block, not one big object: each action then reads only the
		 * slot it owns, so a click can never write back a stale copy of a block it has
		 * nothing to do with. Every "happens once" call sits behind a click — the only
		 * request on mount is `GET /panel`.
		 */
		function WorkbuddyCard() {
			const [panel, setPanel] = React.useState(() => emptyState().panel);
			const [gateway, setGateway] = React.useState(undefined);
			const [credits, setCredits] = React.useState(() => ({ total: "?", accounts: [] }));
			const [directory, setDirectory] = React.useState(() => ({ line: "", compare: "", ns: "", exists: false }));
			const [usage, setUsage] = React.useState(() => ({ phase: "loading", rows: [], models: [], modelsMore: "", note: "" }));
			const [checkin, setCheckin] = React.useState(() => ({ supported: true, note: "" }));
			const [rebuild, setRebuild] = React.useState(() => emptyState().rebuild);
			const [reset, setReset] = React.useState(() => emptyState().reset);
			const [claim, setClaim] = React.useState(() => emptyState().claim);
			const [test, setTest] = React.useState(() => emptyState().test);
			const [busy, setBusy] = React.useState("");
			const [nonce, setNonce] = React.useState(0);
			const alive = React.useRef(true);
			const guard = React.useCallback(
				(fn) =>
					async (...args) => {
						if (alive.current) await fn(...args);
					},
				[]
			);

			/** The ONE request that happens without a click. */
			const load = React.useCallback(
				guard(async () => {
					setPanel({ phase: "loading", detail: "" });
					const answer = await callApi(EP.panel);
					if (!alive.current) return;
					if (!answer.ok) {
						setPanel({ phase: "error", detail: detailOf(answer.payload) || "读取面板失败" });
						setGateway(undefined);
						return;
					}
					const view = panelView(answer.payload);
					setPanel({ phase: view.phase, detail: view.detail });
					setGateway(view.gateway);
					setCredits(view.credits);
					setDirectory(view.directory);
					setUsage(view.usage);
					setCheckin(view.checkin);
				}),
				[]
			);
			const onRebuild = React.useCallback(
				guard(async () => {
					setBusy("rebuild");
					setRebuild({ phase: "loading", detail: "", added: [], hint: "", serverDetail: "" });
					const result = await actRebuild((question) => window.confirm(question));
					if (!alive.current) return;
					setRebuild({ phase: result.phase, detail: result.detail, added: result.added, hint: result.hint, serverDetail: result.serverDetail });
					setBusy("");
					// The rebuild may have changed what the panel reports, so re-read it.
					if (result.phase !== "idle") setNonce((value) => value + 1);
				}),
				[]
			);
			/**
			 * 完全重建 — destructive, so it goes through the same guard as everything
			 * else: one confirm dialog (whose text states the cost) and, only on
			 * acceptance, exactly one POST carrying `reset:true`.
			 */
			const onReset = React.useCallback(
				guard(async () => {
					setBusy("reset");
					setReset({ phase: "loading", detail: "", written: [], dropped: [], serverDetail: "" });
					const result = await actReset((question) => window.confirm(question));
					if (!alive.current) return;
					setReset({ phase: result.phase, detail: result.detail, written: result.written, dropped: result.dropped, serverDetail: result.serverDetail });
					setBusy("");
					if (result.phase !== "idle") setNonce((value) => value + 1);
				}),
				[]
			);
			const onCheckin = React.useCallback(
				guard(async () => {
					setBusy("checkin");
					setClaim({ phase: "loading", detail: "" });
					const result = await actCheckin();
					if (!alive.current) return;
					setClaim({ phase: result.phase, detail: result.detail });
					setBusy("");
				}),
				[]
			);
			const onTest = React.useCallback(
				guard(async () => {
					// Gate 1 of 2 (the request body carries gate 2: `confirm:true`).
					const accepted = window.confirm("测试模型会向真实上游发一次最小请求，会花掉少量额度。\n要现在测试吗？");
					if (accepted !== true) return;
					setBusy("test");
					setTest({ phase: "loading", detail: "", lines: [] });
					const result = await actTest({ confirmed: true });
					if (!alive.current) return;
					setTest({ phase: result.phase, detail: result.detail, lines: result.lines });
					setBusy("");
				}),
				[]
			);
			React.useEffect(() => {
				alive.current = true;
				void load();
				return () => {
					alive.current = false;
				};
			}, [load, nonce]);

			return WorkbuddyCardView({
				panel: panel,
				gateway: gateway,
				credits: credits,
				directory: directory,
				usage: usage,
				checkin: checkin,
				rebuild: rebuild,
				reset: reset,
				claim: claim,
				test: test,
				busy: busy,
				onRebuild: onRebuild,
				onReset: onReset,
				onCheckin: onCheckin,
				onTest: onTest
			});
		}

		/* ─────────────────────── 席位注册（每个单独 try） ─────────────────────── */
		/**
		 * One seat per key, each in its OWN try: a slot this host build does not have
		 * (or a key somebody else already took) must not cost us the other seat.
		 */
		function registerKeys(ctx, slotName, keys) {
			for (const key of keys) {
				try {
					ctx.slots.inject(slotName, () =>
						ctx.slots.register({ name: slotName, key: key, priority: CARD_PRIORITY }, WorkbuddyCard)
					);
				} catch (error) {
					console.warn(`[${PKG}] 席位没有拿到 ${slotName} / ${key}：${msg(error)}`);
				}
			}
		}
		function apply(ctx) {
			registerKeys(ctx, SLOT_BUNDLE, BUNDLE_KEYS);
			registerKeys(ctx, SLOT_ROW, ROW_KEYS);
		}

		exports.apply = apply;
		exports.inject = ["slots"];
		/** Inert for the host, load-bearing for tools/client-bundle-check.mjs. */
		exports.__internals = {
			PKG: PKG,
			ROW_ID: ROW_ID,
			SLOT_BUNDLE: SLOT_BUNDLE,
			SLOT_ROW: SLOT_ROW,
			CARD_PRIORITY: CARD_PRIORITY,
			BUNDLE_KEYS: BUNDLE_KEYS,
			ROW_KEYS: ROW_KEYS,
			ROUTE_BASE: ROUTE_BASE,
			EP: EP,
			callApi: callApi,
			panelView: panelView,
			usageView: usageView,
			accountRow: accountRow,
			directoryLine: directoryLine,
			checkinView: checkinView,
			shapedCredits: shapedCredits,
			formatDuration: formatDuration,
			numText: numText,
			detailOf: detailOf,
			actRebuild: actRebuild,
			actReset: actReset,
			actCheckin: actCheckin,
			actTest: actTest,
			emptyState: emptyState,
			WorkbuddyCardView: WorkbuddyCardView,
			WorkbuddyCard: WorkbuddyCard,
			renderedLines: renderedLines,
			phaseRows: phaseRows,
			stateLine: stateLine,
			preferredBase: () => preferredBase,
			resetPreferredBase: () => {
				preferredBase = ROUTE_BASE[0];
			}
		};
		return exports;
	}
});
