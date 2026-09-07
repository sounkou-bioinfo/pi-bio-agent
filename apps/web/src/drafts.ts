export class Drafts {
  readonly #storage: Storage;
  readonly #save: (id: string, text: string) => Promise<void>;
  readonly #status: (id: string, message: string) => void;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #writes = new Map<string, Promise<boolean>>();

  constructor(storage: Storage, save: (id: string, text: string) => Promise<void>, status: (id: string, message: string) => void) {
    this.#storage = storage;
    this.#save = save;
    this.#status = status;
  }

  restore(id: string, saved: string): string {
    return this.#storage.getItem(`pi-bio.draft.${id}`) ?? saved;
  }

  change(id: string, text: string): void {
    // Keep an immediate local recovery copy until the server acknowledges the write.
    this.#storage.setItem(`pi-bio.draft.${id}`, text);
    this.#status(id, "Saving draft…");
    clearTimeout(this.#timers.get(id));
    this.#timers.set(id, setTimeout(() => void this.flush(id), 400));
  }

  flush(id: string): Promise<boolean> {
    clearTimeout(this.#timers.get(id));
    this.#timers.delete(id);
    const key = `pi-bio.draft.${id}`;
    const text = this.#storage.getItem(key);
    const previous = this.#writes.get(id) ?? Promise.resolve(true);
    if (text === null) return previous;
    const write = previous.then(async () => {
      try {
        await this.#save(id, text);
        if (this.#storage.getItem(key) === text) {
          this.#storage.removeItem(key);
          this.#status(id, text.length > 0 ? "Draft saved" : "");
        }
        return true;
      } catch {
        this.#status(id, "Draft kept on this device. Server save failed.");
        return false;
      }
    });
    this.#writes.set(id, write);
    void write.then(() => {
      if (this.#writes.get(id) === write) this.#writes.delete(id);
    });
    return write;
  }
}
