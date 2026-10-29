import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the real component/handlers with isolated hooks and fake API replies.
// No user chats, network calls, provider requests or database writes are involved.
const source = readFileSync("components/chat-workspace.tsx", "utf8");
const code = ts.transpileModule(source, {
  fileName: "chat-workspace.tsx",
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
const chat = { id: "chat/id ?&", actorId: "actor-btg", title: "Current application" };

function harness({ confirmed = true, reply = async () => ({ ok: true, status: 200 }), loading = false, missing = false, storageThrows = false, activeChat = chat.id } = {}) {
  const slots = [], requests = [], confirmations = [], routes = [];
  const storage = new Map([["katie.activeChatId", activeChat], ["katie.activeActorId", chat.actorId], ["other-setting", "keep"]]);
  let cursor = 0;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [slots[i], next => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }];
    },
    useRef(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: initial };
      return slots[i];
    },
    useEffect() {},
  };
  const jsx = (type, props) => ({ type, props });
  function ChatPanel() {}
  const mocks = {
    react,
    "react/jsx-runtime": { jsx, jsxs: jsx },
    "next/link": { default: "a" },
    "next/navigation": { useRouter: () => ({ replace: path => routes.push(path) }) },
    "@/components/memory-context": { MemoryContext: () => null },
    "@/components/conversation-work": { ConversationWork: () => null },
    "@/components/chat-panel": { ChatPanel },
    "@/components/standalone-usage": { StandaloneUsage: () => null },
    "@/components/workspace-data": { useResource: path => ({
      data: path === "/api/actors" ? { actors: [{ id: chat.actorId, name: "BTG" }] }
        : path === "/api/chats" ? { chats: missing ? [] : [chat] } : { repos: [] },
      loading, error: "", refresh() {},
    }) },
    "@/components/saved-workspace-state": { useSavedState: () => ({ state: { value: {} }, saving: false, error: "", save: async () => {} }) },
  };
  const exports = {};
  runInNewContext(code, {
    exports,
    require(name) {
      assert.ok(name in mocks, `Unexpected component dependency: ${name}`);
      return mocks[name];
    },
    window: {
      confirm(message) { confirmations.push(message); return confirmed; },
      localStorage: {
        getItem(key) { if (storageThrows) throw Error("Storage denied"); return storage.get(key) ?? null; },
        removeItem(key) { storage.delete(key); },
      },
    },
    fetch: async (url, options) => { requests.push({ url, method: options.method }); return reply(); },
  }, { filename: "chat-workspace.js" });
  return {
    render() { cursor = 0; return exports.default({ conversationId: chat.id }); },
    requests, confirmations, routes, storage, ChatPanel,
  };
}
function all(node) {
  if (Array.isArray(node)) return node.flatMap(all);
  if (!node || typeof node !== "object") return [];
  return [node, ...all(node.props?.children)];
}
function deleteButton(tree) {
  const button = all(tree).find(node => node.type === "button" && node.props["aria-label"] === `Delete chat: ${chat.title}`);
  assert.ok(button, "Open conversation has an accessible Delete chat button");
  return button;
}
function alert(tree) { return all(tree).find(node => node.props?.role === "alert"); }

test("delete is visible outside the collapsed settings and identifies this chat", () => {
  const h = harness(), tree = h.render(), button = deleteButton(tree);
  assert.equal(button.props.type, "button");
  assert.equal(button.props.children, "Delete chat");
  assert.equal(button.props.disabled, false);
  assert.match(button.props.className, /min-h-11/);
  for (const details of all(tree).filter(node => node.type === "details")) {
    assert.ok(!all(details).includes(button), "Deletion must not be hidden inside settings");
  }
});

test("canceling confirmation sends no deletion and keeps the conversation", async () => {
  const h = harness({ confirmed: false });
  deleteButton(h.render()).props.onClick();
  await flush();
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0], /Current application/);
  assert.match(h.confirmations[0], /cannot be undone/);
  assert.match(h.confirmations[0], /long-term memory will be kept/);
  assert.equal(h.requests.length, 0);
  assert.equal(h.routes.length, 0);
  assert.equal(h.storage.get("katie.activeChatId"), chat.id);
  assert.ok(all(h.render()).some(node => node.type === h.ChatPanel));
});

test("confirmed deletion calls only the existing exact-chat endpoint and leaves for Conversations", async () => {
  const h = harness();
  deleteButton(h.render()).props.onClick();
  await flush();
  assert.deepEqual(h.requests, [{ url: `/api/chats?id=${encodeURIComponent(chat.id)}`, method: "DELETE" }]);
  assert.deepEqual(h.routes, ["/conversations"]);
  assert.equal(h.storage.has("katie.activeChatId"), false);
  assert.equal(h.storage.get("katie.activeActorId"), chat.actorId);
  assert.equal(h.storage.get("other-setting"), "keep");
  assert.ok(!all(h.render()).some(node => node.type === h.ChatPanel), "Deleted chat cannot still accept input");
  assert.equal(all(h.render()).find(node => node.props?.role === "status").props.children, "Conversation deleted.");
});

test("in-flight deletion disables the button and ignores repeated clicks", async () => {
  let finish;
  const h = harness({ reply: () => new Promise(resolve => { finish = resolve; }) });
  const originalButton = deleteButton(h.render());
  originalButton.props.onClick();
  originalButton.props.onClick();
  const pendingButton = deleteButton(h.render());
  assert.equal(pendingButton.props.disabled, true);
  assert.equal(pendingButton.props.children, "Deleting…");
  pendingButton.props.onClick();
  assert.equal(h.requests.length, 1);
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.routes.length, 0);
  finish({ ok: true, status: 200 });
  await flush();
  assert.deepEqual(h.routes, ["/conversations"]);
});

test("HTTP failure preserves the conversation and offers a working retry", async () => {
  let attempts = 0;
  const h = harness({ reply: async () => ++attempts === 1 ? { ok: false, status: 500 } : { ok: true, status: 200 } });
  deleteButton(h.render()).props.onClick();
  await flush();
  const failed = h.render();
  assert.match(alert(failed).props.children, /Could not delete/);
  assert.equal(deleteButton(failed).props.disabled, false);
  assert.ok(all(failed).some(node => node.type === h.ChatPanel));
  assert.equal(h.routes.length, 0);
  assert.equal(h.storage.get("katie.activeChatId"), chat.id);
  deleteButton(failed).props.onClick();
  assert.equal(alert(h.render()), undefined, "Retry clears the old error");
  await flush();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.routes, ["/conversations"]);
});

test("network failure keeps the chat open without clearing its active pointer", async () => {
  const h = harness({ reply: async () => { throw Error("Offline"); } });
  deleteButton(h.render()).props.onClick();
  await flush();
  assert.ok(alert(h.render()));
  assert.equal(deleteButton(h.render()).props.disabled, false);
  assert.equal(h.routes.length, 0);
  assert.equal(h.storage.get("katie.activeChatId"), chat.id);
});

test("authorization errors do not navigate or claim deletion", async () => {
  for (const status of [401, 403]) {
    const h = harness({ reply: async () => ({ ok: false, status }) });
    deleteButton(h.render()).props.onClick();
    await flush();
    assert.ok(alert(h.render()));
    assert.equal(h.routes.length, 0);
  }
});

test("an already-deleted chat (404) also returns safely to Conversations", async () => {
  const h = harness({ reply: async () => ({ ok: false, status: 404 }) });
  deleteButton(h.render()).props.onClick();
  await flush();
  assert.deepEqual(h.routes, ["/conversations"]);
  assert.equal(alert(h.render()), undefined);
});

test("restricted local storage cannot strand a successfully deleted chat", async () => {
  const h = harness({ storageThrows: true });
  deleteButton(h.render()).props.onClick();
  await flush();
  assert.deepEqual(h.routes, ["/conversations"]);
  assert.equal(alert(h.render()), undefined);
});

test("deleting this chat does not clear a different chat selected in another tab", async () => {
  const h = harness({ activeChat: "other-chat" });
  deleteButton(h.render()).props.onClick();
  await flush();
  assert.equal(h.storage.get("katie.activeChatId"), "other-chat");
});

test("loading or unavailable conversations do not offer a deletion control", () => {
  for (const options of [{ loading: true }, { missing: true }]) {
    const h = harness(options);
    assert.ok(!all(h.render()).some(node => node.type === "button" && node.props["aria-label"]?.startsWith("Delete chat:")));
    assert.equal(h.requests.length, 0);
  }
});
