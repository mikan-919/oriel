// worker-build generates this Rust export. Keep type checking independent of a Wasm build.
declare module "*build/index.js" {
  export class RelayDevice {
    constructor(state: DurableObjectState, env: unknown);
    fetch(request: Request): Promise<Response>;
  }
}
