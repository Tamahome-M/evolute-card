import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Window } from "happy-dom";

const source = await readFile(new URL("../dist/evolute-card.js", import.meta.url), "utf8");
// Captured from the integration's real HA platform/service test, with mocked HTTP.
const contract = JSON.parse(await readFile(new URL("./fixtures/ha-current.json", import.meta.url), "utf8"));
const flush = () => new Promise((resolve) => setImmediate(resolve));

function entity(hass, key) {
  return Object.values(hass.entities).find((e) => e.translation_key === key).entity_id;
}

function setState(hass, key, state, attributes = {}) {
  const id = entity(hass, key);
  hass.states[id] = { ...hass.states[id], state, attributes: {
    ...hass.states[id]?.attributes, ...attributes,
  } };
}

async function screen(t, phase = "success", service = async () => {}) {
  const window = new Window();
  t.after(() => window.happyDOM.close());
  window.eval(source);
  const hass = structuredClone(contract.snapshots[phase]);
  const calls = [];
  hass.callService = (...args) => { calls.push(structuredClone(args)); return service(...args); };
  const card = window.document.createElement("evolute-card");
  card.setConfig({ hide_prepare: false });
  window.document.body.append(card);
  card.hass = hass;
  await flush();
  return { window, hass, card, root: card.shadowRoot, calls };
}

test("uses the entity keys produced by current HA and displays battery temperature / percent / range", async (t) => {
  const { root, card, hass } = await screen(t);
  assert.equal(contract.integration_version, "1.2.18b0");
  assert.equal(card._eid("lock"), entity(hass, "central_lock"));
  assert.match(root.querySelector('.barval[data-role="battery_pct"]').textContent, /19°C \/ 92% \/ 101 км/);
  setState(hass, "battery_temp", "21");
  card.hass = hass;
  assert.match(root.querySelector('.barval[data-role="battery_pct"]').textContent, /21°C/);
  setState(hass, "battery_temp", "unavailable");
  card.hass = hass;
  assert.match(root.querySelector('.barval[data-role="battery_pct"]').textContent, /—°C/);
});

test("the plugged-in connector replaces the online dot and does not claim charging", async (t) => {
  const { root, card, hass } = await screen(t);
  assert.ok(root.querySelector(".odo .plug"));
  assert.ok(!root.querySelector(".odo .dot"));
  assert.equal(root.querySelector(".odo .plug").getAttribute("aria-label"), "Зарядный пистолет вставлен");
  assert.doesNotMatch(root.textContent, /Ид[её]т зарядка/);
  setState(hass, "charging_gun", "off");
  card.hass = hass;
  assert.ok(!root.querySelector(".odo .plug"));
  assert.ok(root.querySelector(".odo .dot"));
});

test("renders each server receipt and blocks controls while commands execute", async (t) => {
  const { root, card, hass, calls } = await screen(t, "pending");
  assert.equal(root.querySelector('[aria-current="step"]').textContent, "Отправлена");
  assert.ok(root.querySelector('[data-role="lock"]').disabled);
  card._lockToggle();
  assert.equal(calls.length, 0);
  setState(hass, "command_status", "delivered");
  card.hass = hass;
  assert.equal(root.querySelector('[aria-current="step"]').textContent, "Доставлена");
  setState(hass, "central_lock", "locked");
  setState(hass, "command_status", "success");
  card.hass = hass;
  assert.equal(root.querySelector('[aria-current="step"]').textContent, "Выполнена");
  assert.equal(root.querySelector('[data-role="lock"]').disabled, false);
});

test("locking and unlocking are progress states, with no opposite command", async (t) => {
  const { root, card, hass, calls } = await screen(t);
  for (const [state, label] of [["locking", "Закрывается…"], ["unlocking", "Открывается…"]]) {
    setState(hass, "central_lock", state);
    card.hass = hass;
    assert.match(root.querySelector('[data-role="lock"]').textContent, new RegExp(label));
    assert.ok(root.querySelector('[data-role="lock"]').disabled);
    card._lockToggle();
  }
  assert.equal(calls.length, 0);
});

test("one click issues one HA service call until its promise completes", async (t) => {
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const { root, card, hass, calls } = await screen(t, "success", () => pending);
  setState(hass, "central_lock", "unlocked");
  card.hass = hass;
  const action = card._lockToggle();
  card._lockToggle();
  assert.deepEqual(calls, [["lock", "lock", { entity_id: entity(hass, "central_lock") }]]);
  assert.ok(root.querySelector('[data-role="lock"]').disabled);
  assert.ok(!root.querySelector('[aria-current="step"]'));
  resolve();
  await action;
  assert.equal(root.querySelector('[data-role="lock"]').disabled, false);
});

test("service errors are visible and escaped, then controls recover", async (t) => {
  const { root, card } = await screen(t, "success", async () => { throw new Error("<img src=x onerror=alert(1)>"); });
  await card._lockToggle();
  assert.match(root.querySelector('[role="alert"]').textContent, /<img/);
  assert.ok(!root.querySelector("img"));
  assert.ok(!root.querySelector('[aria-current="step"]'));
  assert.equal(root.querySelector('[data-role="lock"]').disabled, false);
});

test("same status with a new command id updates the title, and profile prep uses its own button", async (t) => {
  const { root, card, hass, calls } = await screen(t, "pending");
  setState(hass, "command_status", "pending", { command: "trunkOpen", command_id: "new-command" });
  card.hass = hass;
  assert.match(root.querySelector(".command-title").textContent, /багажника/);
  setState(hass, "command_status", "success");
  setState(hass, "central_lock", "locked");
  setState(hass, "trip_preparation", "off");
  card.hass = hass;
  card._ctrl("trip");
  await flush();
  assert.deepEqual(calls, [["button", "press", { entity_id: entity(hass, "trip_prepare_on") }]]);
});

test("unavailable buttons and offline vehicles cannot send commands", async (t) => {
  const { root, card, hass, calls } = await screen(t);
  setState(hass, "blink", "unavailable");
  card.hass = hass;
  assert.ok(root.querySelector('[data-role="blink"]').disabled);
  card._ctrl("blink");
  setState(hass, "online", "off");
  card.hass = hass;
  card._lockToggle();
  assert.equal(calls.length, 0);
});
