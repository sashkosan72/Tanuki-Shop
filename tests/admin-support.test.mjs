import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/admin/index.html", import.meta.url), "utf8");
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)][0][1];

class Element {
  constructor(classes = "") {
    const names = new Set(classes.split(/\s+/).filter(Boolean));
    this.classList = {
      add: (...values) => values.forEach(value => names.add(value)),
      remove: (...values) => values.forEach(value => names.delete(value)),
      contains: value => names.has(value),
      toggle(value, force) {
        const enabled = force === undefined ? !names.has(value) : Boolean(force);
        if (enabled) names.add(value); else names.delete(value);
        return enabled;
      }
    };
    this.listeners = new Map();
    this.value = "";
    this.disabled = false;
    this.textContent = "";
    this.innerHTML = "";
    this.scrollHeight = 20;
    this.scrollTop = 0;
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  dispatch(type) {
    return this.listeners.get(type)?.({ preventDefault() {}, target: this });
  }
}

// Execute the actual admin inline script; all browser/network boundaries stay local.
async function admin() {
  const elements = new Map();
  for (const [, id, classes] of html.matchAll(/\bid="([^"]+)"(?:\s+class="([^"]*)")?/g)) {
    elements.set(id, new Element(classes));
  }
  const calls = [];
  let deferredLists = 0;
  const response = data => ({ ok: true, json: async () => data });
  const context = vm.createContext({
    document: {
      getElementById(id) {
        assert(elements.has(id), `Unknown DOM element ${id}`);
        return elements.get(id);
      },
      querySelectorAll: () => [],
      addEventListener() {}
    },
    FormData,
    confirm: () => true,
    console,
    setTimeout,
    clearTimeout,
    fetch(path, options = {}) {
      const call = { path, method: options.method || "GET", body: options.body };
      calls.push(call);
      if (path === "/api/admin/me") return Promise.resolve(response({ ok: true, authenticated: false }));
      if (path === "/api/admin/support" && deferredLists === 0) return Promise.resolve(response({ ok: true, chats: [] }));
      if (path === "/api/admin/support") deferredLists--;
      assert.match(path, /^\/api\/admin\/(support(?:\/\d+(?:\/reply|\/close)?)?|logout)$/,
        "Unexpected request: no network access is available in these tests");
      return new Promise((resolve, reject) => {
        call.resolve = data => resolve(response({ ok: true, ...data }));
        call.reject = reject;
      });
    }
  });
  vm.runInContext(script, context, { filename: "public/admin/index.html:inline" });
  // Let the real session bootstrap finish before testing support interactions.
  await new Promise(setImmediate);
  return {
    elements,
    calls,
    deferNextList: () => { deferredLists++; },
    element: id => elements.get(id),
    open: id => vm.runInContext(`openSupportChat(${Number(id)})`, context),
    request(path, method = "GET") {
      const call = calls.findLast(item => item.path === path && item.method === method);
      assert(call, `Missing ${method} ${path}`);
      return call;
    },
    mutations: () => calls.filter(call => call.method !== "GET")
  };
}

const chat = (id, status = "open") => ({
  chat: { id, customer_name: `Buyer ${id}`, telegram_id: `test-${id}`, status },
  messages: [{ sender: "buyer", message_text: `Message ${id}`, created_at: "2026-10-20" }]
});

async function show(app, id, status = "open") {
  const opened = app.open(id);
  app.request(`/api/admin/support/${id}`).resolve(chat(id, status));
  await opened;
}

function assertActionsBlocked(app) {
  assert.equal(app.element("replyButton").disabled, true);
  assert.equal(app.element("closeChatButton").disabled, true);
}

test("late chat responses cannot replace the selected buyer or enable a different recipient", async () => {
  const app = await admin();
  const first = app.open(1);
  const second = app.open(2);
  app.request("/api/admin/support/2").resolve(chat(2));
  await second;
  app.element("replyText").value = "Draft for buyer 2";

  app.request("/api/admin/support/1").resolve(chat(1));
  await first;

  assert.match(app.element("chatHeading").innerHTML, /Buyer 2/);
  assert.doesNotMatch(app.element("chatHeading").innerHTML, /Buyer 1/);
  assert.match(app.element("messages").innerHTML, /Message 2/);
  assert.equal(app.element("replyText").value, "Draft for buyer 2");
  assert.equal(app.element("replyButton").disabled, false);
});

test("an outdated chat load error does not overwrite the current chat", async () => {
  const app = await admin();
  const first = app.open(1);
  await show(app, 2);
  app.element("supportMessage").textContent = "Current chat status";
  app.request("/api/admin/support/1").reject(new Error("Old request failed"));
  await first;

  assert.match(app.element("chatHeading").innerHTML, /Buyer 2/);
  assert.match(app.element("messages").innerHTML, /Message 2/);
  assert.equal(app.element("supportMessage").textContent, "Current chat status");
});

test("reply and close reject programmatic actions while the recipient is loading", async () => {
  const app = await admin();
  await show(app, 1);
  const loading = app.open(2);
  app.element("replyText").value = "Old or programmatic draft";
  assertActionsBlocked(app);
  await app.element("replyForm").dispatch("submit");
  await app.element("closeChatButton").dispatch("click");
  assert.equal(app.mutations().length, 0);

  app.request("/api/admin/support/2").resolve(chat(2));
  await loading;
  assert.equal(app.element("replyButton").disabled, false);
});

test("failed or mismatched loads and closed chats cannot receive replies or close actions", async t => {
  for (const scenario of ["failure", "mismatched", "closed"]) {
    await t.test(scenario, async () => {
      const app = await admin();
      const loading = app.open(1);
      const pending = app.request("/api/admin/support/1");
      if (scenario === "failure") pending.reject(new Error("Cannot load buyer"));
      else pending.resolve(chat(scenario === "mismatched" ? 2 : 1, scenario === "closed" ? "closed" : "open"));
      await loading;
      assertActionsBlocked(app);
      app.element("replyText").value = "Cannot send this";
      await app.element("replyForm").dispatch("submit");
      await app.element("closeChatButton").dispatch("click");
      assert.equal(app.mutations().length, 0);
      if (scenario === "mismatched") assert.doesNotMatch(app.element("chatHeading").innerHTML, /Buyer 2/);
      if (scenario === "failure") assert.match(app.element("supportMessage").textContent, /Cannot load buyer/);
    });
  }
});

for (const outcome of ["success", "failure"]) {
  test(`an old reply ${outcome} keeps its captured recipient and cannot clear the new chat draft`, async () => {
    const app = await admin();
    await show(app, 1);
    app.element("replyText").value = "Reply to buyer 1";
    const sending = app.element("replyForm").dispatch("submit");
    const sent = app.request("/api/admin/support/1/reply", "POST");
    assert.equal(JSON.parse(sent.body).message, "Reply to buyer 1");

    await show(app, 2);
    app.element("replyText").value = "Draft for buyer 2";
    app.element("supportMessage").textContent = "Status for buyer 2";
    if (outcome === "success") sent.resolve({});
    else sent.reject(new Error("Old reply failed"));
    await sending;

    assert.match(app.element("chatHeading").innerHTML, /Buyer 2/);
    assert.equal(app.element("replyText").value, "Draft for buyer 2");
    assert.equal(app.element("supportMessage").textContent, "Status for buyer 2");
    assert.deepEqual(app.mutations().map(call => call.path), ["/api/admin/support/1/reply"]);
    assert.equal(app.calls.filter(call => call.path === "/api/admin/support/1").length, 1);
  });
}

test("finishing an old reply cannot enable controls while the newly selected chat is loading", async () => {
  const app = await admin();
  await show(app, 1);
  app.element("replyText").value = "Reply to buyer 1";
  const sending = app.element("replyForm").dispatch("submit");
  const loading = app.open(2);
  app.request("/api/admin/support/1/reply", "POST").resolve({});
  await sending;
  assertActionsBlocked(app);
  app.request("/api/admin/support/2").resolve(chat(2));
  await loading;
});

test("an old close completion cannot return to the previous buyer or clear the new draft", async () => {
  const app = await admin();
  await show(app, 1);
  const closing = app.element("closeChatButton").dispatch("click");
  const close = app.request("/api/admin/support/1/close", "PATCH");
  await show(app, 2);
  app.element("replyText").value = "Draft for buyer 2";
  close.resolve({});
  await closing;

  assert.match(app.element("chatHeading").innerHTML, /Buyer 2/);
  assert.equal(app.element("replyText").value, "Draft for buyer 2");
  assert.equal(app.calls.filter(call => call.path === "/api/admin/support/1").length, 1);
  assert.deepEqual(app.mutations().map(call => call.path), ["/api/admin/support/1/close"]);
});

test("an earlier reply refresh cannot replace a newer same-chat action error with success", async () => {
  const app = await admin();
  await show(app, 1);
  app.element("replyText").value = "First reply";
  const firstSend = app.element("replyForm").dispatch("submit");
  app.request("/api/admin/support/1/reply", "POST").resolve({});
  await new Promise(setImmediate);

  // The first reply has refreshed the detail but is still awaiting the chat list.
  app.deferNextList();
  app.request("/api/admin/support/1").resolve(chat(1));
  await new Promise(setImmediate);
  assert.equal(app.element("replyButton").disabled, false);
  const pendingList = app.request("/api/admin/support");

  app.element("replyText").value = "Second reply";
  const secondSend = app.element("replyForm").dispatch("submit");
  app.request("/api/admin/support/1/reply", "POST").reject(new Error("Newer reply failed"));
  await secondSend;
  assert.match(app.element("supportMessage").textContent, /Newer reply failed/);

  pendingList.resolve({ chats: [] });
  await firstSend;
  assert.match(app.element("supportMessage").textContent, /Newer reply failed/);
});

test("logout invalidates outstanding chat loads before the logout request finishes", async () => {
  const app = await admin();
  const loading = app.open(1);
  const loggingOut = app.element("logoutButton").dispatch("click");
  assertActionsBlocked(app);
  app.request("/api/admin/support/1").resolve(chat(1));
  await loading;
  assert.doesNotMatch(app.element("chatHeading").innerHTML, /Buyer 1/);
  assert.doesNotMatch(app.element("messages").innerHTML, /Message 1/);
  app.request("/api/admin/logout", "POST").resolve({});
  await loggingOut;
  assertActionsBlocked(app);
});
