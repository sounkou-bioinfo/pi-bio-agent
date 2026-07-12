import type { OpenAPIHono } from "@hono/zod-openapi";

export interface WorkbenchAddonDescriptor {
  id: string;
  label: string;
  order: number;
  browserEntry: string;
}

/** Host-approved application contribution: API registration plus one browser module.
 *
 * Addons do not own scientific storage. They read and write through the public substrate and expose durable ids,
 * CAS references, and observations. Loading/install policy and browser asset serving remain host responsibilities.
 */
export interface WorkbenchAddon extends WorkbenchAddonDescriptor {
  registerApi(app: OpenAPIHono): void;
}

export function addonDescriptor(addon: WorkbenchAddon): WorkbenchAddonDescriptor {
  const { id, label, order, browserEntry } = addon;
  return { id, label, order, browserEntry };
}
