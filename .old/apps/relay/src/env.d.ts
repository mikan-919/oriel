import type { DeviceRegistryObject } from "./device-registry-object";

declare global {
  namespace Cloudflare {
    interface Env {
      DEVICE_REGISTRY: DurableObjectNamespace<DeviceRegistryObject>;
    }
  }
}

export {};
