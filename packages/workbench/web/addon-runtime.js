const registrations = new Map();

export function registerWorkbenchAddon(addon) {
  if (!addon || typeof addon !== "object") throw new Error("workbench addon must be an object");
  if (typeof addon.id !== "string" || !addon.id.trim()) throw new Error("workbench addon id must be non-empty");
  if (typeof addon.mount !== "function") throw new Error(`workbench addon '${addon.id}' requires mount(container, host)`);
  if (registrations.has(addon.id)) throw new Error(`workbench addon '${addon.id}' registered twice`);
  registrations.set(addon.id, addon);
}

export async function mountWorkbenchAddons({ descriptors, tabs, workspace, agentView, host }) {
  for (const descriptor of descriptors) await import(descriptor.browserEntry);

  const mounted = new Map();
  const entries = [{ id: "agent", label: "Agent", order: 0, element: agentView }];
  for (const descriptor of descriptors) {
    const registration = registrations.get(descriptor.id);
    if (!registration) throw new Error(`browser entry '${descriptor.browserEntry}' did not register '${descriptor.id}'`);
    const element = document.createElement("section");
    element.id = `${descriptor.id}-view`;
    element.className = "view addon-view";
    element.setAttribute("aria-label", descriptor.label);
    workspace.append(element);
    mounted.set(descriptor.id, await registration.mount(element, host));
    entries.push({ ...descriptor, element });
  }

  entries.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const buttons = new Map();
  const activate = (id) => {
    for (const entry of entries) {
      const active = entry.id === id;
      entry.element.classList.toggle("active", active);
      buttons.get(entry.id)?.classList.toggle("active", active);
      const instance = mounted.get(entry.id);
      if (active) instance?.activate?.();
      else instance?.deactivate?.();
    }
  };
  for (const entry of entries) {
    const button = document.createElement("button");
    button.className = "tab";
    button.type = "button";
    button.dataset.view = entry.id;
    button.textContent = entry.label;
    button.addEventListener("click", () => activate(entry.id));
    buttons.set(entry.id, button);
    tabs.append(button);
  }
  activate("agent");

  return {
    activate,
    dispose() {
      for (const instance of mounted.values()) instance?.dispose?.();
      mounted.clear();
      tabs.replaceChildren();
    },
  };
}
