import { createModels, type AuthInteraction } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it, vi } from "vitest";
import { CredentialService } from "../src/credential-service.js";

function fixture() {
  const models = createModels();
  const faux = fauxProvider({ provider: "test-provider" });
  models.setProvider({ ...faux.provider, auth: { oauth: {
    name: "Test subscription",
    login: async (interaction: AuthInteraction) => {
      const method = await interaction.prompt({ type: "select", message: "Choose a method", options: [{ id: "test-flow", label: "Test flow" }] });
      expect(method).toBe("test-flow");
      interaction.notify({ type: "device_code", userCode: "ABCD", verificationUri: "https://example.org/login" });
      const secret = await interaction.prompt({ type: "secret", message: "Enter code" });
      return { type: "oauth", access: secret, refresh: "secret-refresh", expires: Date.now() + 60_000 };
    },
    refresh: async (credential) => credential,
    toAuth: async (credential) => ({ apiKey: credential.access }),
  } } });
  return { models, service: new CredentialService(models) };
}

describe("Pi authentication interaction bridge", () => {
  it("forwards provider prompts and notifications without leaking credentials", async () => {
    const { service } = fixture();
    expect(service.catalog()[0]?.methods).toEqual([{ type: "oauth", name: "Test subscription" }]);
    await service.login("test-provider", { type: "oauth" });
    await vi.waitFor(async () => expect((await service.status("test-provider")).prompt?.type).toBe("select"));
    let status = await service.status("test-provider");
    await expect(service.answer("test-provider", { promptId: status.prompt!.id, value: "unlisted-option" })).rejects.toThrow("Invalid sign-in option");
    await service.answer("test-provider", { promptId: status.prompt!.id, value: "test-flow" });
    await vi.waitFor(async () => expect((await service.status("test-provider")).prompt?.type).toBe("secret"));
    status = await service.status("test-provider");
    expect(status.event).toMatchObject({ type: "device_code", userCode: "ABCD" });
    await service.answer("test-provider", { promptId: status.prompt!.id, value: "secret-access" });
    await vi.waitFor(async () => expect((await service.status("test-provider")).status).toBe("connected"));
    expect(JSON.stringify(await service.status("test-provider"))).not.toContain("secret-access");
    await service.close();
  });

  it("cancels a pending interaction and rejects stale prompt answers", async () => {
    const { service } = fixture();
    await service.login("test-provider", { type: "oauth" });
    await vi.waitFor(async () => expect((await service.status("test-provider")).prompt).toBeDefined());
    const promptId = (await service.status("test-provider")).prompt!.id;
    expect((await service.cancel("test-provider")).status).toBe("disconnected");
    await expect(service.answer("test-provider", { promptId, value: "test-flow" })).rejects.toThrow("no longer active");
  });
});
