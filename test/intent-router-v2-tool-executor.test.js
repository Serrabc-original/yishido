import test from "node:test";
import assert from "node:assert/strict";
import { executeIntentRouterV2Tools } from "../src/tools/toolExecutor.js";

test("IntentRouterV2 tool executor searches local CRM records", () => {
  const result = executeIntentRouterV2Tools({
    routerResult: {
      tasks: [{
        intent: "crm.search",
        status: "ready",
        entities: { cedula: "0102030405" }
      }]
    },
    policyDecision: { shouldExecuteTools: true },
    data: {
      coreUtilityState: {
        clients: [{
          clientId: "client_1",
          name: "Juan Perez",
          cedula: "0102030405",
          phone: "0999999999",
          email: "juan@test.com"
        }]
      }
    }
  });

  assert.equal(result.handled, true);
  assert.deepEqual(result.executedTools, ["crm.search"]);
  assert.equal(result.toolResults[0].ok, true);
  assert.equal(result.toolResults[0].count, 1);
  assert.equal(result.toolResults[0].matches[0].raw.name, "Juan Perez");
});

test("IntentRouterV2 tool executor stores and applies confirmed CRM update", () => {
  const pending = executeIntentRouterV2Tools({
    routerResult: {
      tasks: [{
        intent: "crm.update",
        status: "needs_confirmation",
        entities: {
          name: "Juan Perez",
          email: "nuevo@test.com",
          phone: "0999999999",
          notes: "quiere plan premium"
        }
      }]
    },
    policyDecision: { shouldExecuteTools: false },
    data: { coreUtilityState: { clients: [] } },
    now: "2026-06-17T22:00:00.000Z"
  });

  assert.equal(pending.handled, true);
  assert.equal(pending.updatedData.coreUtilityState.pendingCrmAction.intent, "crm.update");

  const confirmed = executeIntentRouterV2Tools({
    routerResult: {
      tasks: [{
        intent: "crm.update",
        status: "ready",
        entities: pending.updatedData.coreUtilityState.pendingCrmAction.entities
      }]
    },
    policyDecision: { shouldExecuteTools: true },
    data: pending.updatedData,
    now: "2026-06-17T22:01:00.000Z"
  });

  assert.equal(confirmed.handled, true);
  assert.deepEqual(confirmed.executedTools, ["crm.update"]);
  assert.equal(confirmed.updatedData.coreUtilityState.pendingCrmAction, null);
  assert.equal(confirmed.updatedData.coreUtilityState.clients.length, 1);
  assert.equal(confirmed.updatedData.coreUtilityState.clients[0].email, "nuevo@test.com");
});

test("IntentRouterV2 tool executor finds existing documents without generating files", () => {
  const result = executeIntentRouterV2Tools({
    routerResult: {
      tasks: [{
        intent: "document.search",
        status: "ready",
        entities: { query: "catalogo actualizado" }
      }]
    },
    policyDecision: { shouldExecuteTools: true },
    data: {
      coreUtilityState: {
        documents: [{
          id: "doc_catalogo",
          name: "Catalogo actualizado",
          url: "https://docs.test/catalogo.pdf"
        }]
      }
    }
  });

  assert.equal(result.handled, true);
  assert.deepEqual(result.executedTools, ["document.search"]);
  assert.equal(result.toolResults[0].ok, true);
  assert.equal(result.toolResults[0].generated, false);
  assert.equal(result.toolResults[0].document.url, "https://docs.test/catalogo.pdf");
});

test("IntentRouterV2 tool executor reports missing document without creating one", () => {
  const result = executeIntentRouterV2Tools({
    routerResult: {
      tasks: [{
        intent: "document.search",
        status: "ready",
        entities: { query: "contrato premium" }
      }]
    },
    policyDecision: { shouldExecuteTools: true },
    data: { coreUtilityState: { documents: [] } }
  });

  assert.equal(result.handled, true);
  assert.equal(result.toolResults[0].ok, true);
  assert.equal(result.toolResults[0].count, 0);
  assert.equal(result.toolResults[0].generated, false);
});
