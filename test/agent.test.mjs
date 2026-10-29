import { expect, test } from "bun:test";
import { agent, connect } from "../agent.mjs";

test("agent descriptor points at Snow App", () => {
  expect(agent.id).toBe("snowapp");
  expect(agent.name).toBe("Snow App");
  expect(agent.dir).toBe("~/.snowapp");
  expect(agent.config).toBe("~/.snowapp/magpie-agent.json");
  expect(agent.format).toBe("json");
  expect(agent.model).toBe("model");
  expect(agent.icon.startsWith("data:image/png;base64,")).toBe(true);
});

test("connect writes the gateway and the picked model's limits", () => {
  const keys = connect({
    gateway: {
      url: "http://127.0.0.1:3425",
      v1: "http://127.0.0.1:3425/v1",
      key: "magpie-snowapp-test",
    },
    model: {
      id: "openai/gpt-5",
      name: "GPT-5",
      context: 400000,
      output: 128000,
      images: true,
    },
  });

  expect(keys["magpie.v1"]).toBe("http://127.0.0.1:3425/v1");
  expect(keys["magpie.key"]).toBe("magpie-snowapp-test");
  expect(keys["magpie.model"]).toBe("openai/gpt-5");
  expect(keys["magpie.name"]).toBe("GPT-5");
  expect(keys["magpie.context"]).toBe(400000);
  expect(keys["magpie.output"]).toBe(128000);
  expect(keys["magpie.images"]).toBe(true);
  expect(keys["magpie.profile"]).toBe("magpie-agent");
  expect(keys.model).toBeUndefined();
});

test("connect stays usable when the model has no metadata", () => {
  const keys = connect({
    gateway: { url: "http://127.0.0.1:3425", v1: "http://127.0.0.1:3425/v1", key: "k" },
    model: { id: "group/fast" },
  });
  expect(keys["magpie.model"]).toBe("group/fast");
  expect(keys["magpie.context"]).toBe(0);
  expect(keys["magpie.output"]).toBe(0);
  expect(keys["magpie.images"]).toBe(false);
});
