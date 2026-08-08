import { adapterKey } from "./profile.js";
import type { AdapterDescriptor, AdapterReference } from "./types.js";

export class DescriptorRegistry {
  private readonly entries = new Map<string, AdapterDescriptor>();

  constructor(descriptors: readonly AdapterDescriptor[] = []) {
    for (const descriptor of descriptors) this.register(descriptor);
  }

  register(descriptor: AdapterDescriptor): void {
    const key = adapterKey(descriptor.ref);
    if (this.entries.has(key)) throw new Error(`Duplicate adapter '${key}'.`);
    this.entries.set(key, descriptor);
  }

  resolve(reference: AdapterReference, action?: string): AdapterDescriptor {
    const key = adapterKey(reference);
    const descriptor = this.entries.get(key);
    if (!descriptor) throw new Error(`Unknown adapter '${key}'.`);
    if (descriptor.ref.kind !== reference.kind) {
      throw new Error(`Adapter '${key}' has the wrong kind.`);
    }
    if (action && !descriptor.actions.includes(action)) {
      throw new Error(`Adapter '${key}' does not declare action '${action}'.`);
    }
    return descriptor;
  }

  list(kind?: AdapterReference["kind"]): AdapterDescriptor[] {
    return [...this.entries.values()]
      .filter((entry) => kind === undefined || entry.ref.kind === kind)
      .sort((left, right) =>
        adapterKey(left.ref).localeCompare(adapterKey(right.ref)),
      );
  }
}
