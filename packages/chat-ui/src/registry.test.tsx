import { describe, expect, it } from "vitest";
import { ChatApp } from "./components/ChatApp";
import { listRenderDefinitions, listRenderTypes } from "./registry";

describe("artifact renderer registry", () => {
  it("has builtin renderers as soon as ChatApp is loaded", () => {
    expect(ChatApp).toBeDefined();
    expect(listRenderTypes()).toEqual(
      expect.arrayContaining(["iframe", "image", "markdown"]),
    );
  });

  it("reports payload schemas for builtin renderers", () => {
    const definitions = Object.fromEntries(
      listRenderDefinitions().map((definition) => [
        definition.type,
        definition,
      ]),
    );

    for (const type of ["iframe", "image", "markdown"]) {
      expect(definitions[type]?.payloadSchema).toBeTruthy();
    }
  });
});
