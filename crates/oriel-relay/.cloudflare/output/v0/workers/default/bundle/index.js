var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// build/index.js
import { WorkerEntrypoint as pe } from "cloudflare:workers";
import Y from "./8c9aab654007190699c846b345543622561537a0-index_bg.wasm";
var K = globalThis.__worker_init_state = { criticalError: false, instanceId: 0 };
var v = class {
  static {
    __name(this, "v");
  }
  __destroy_into_raw() {
    let e = this.__wbg_ptr;
    return this.__wbg_ptr = 0, ce.unregister(this), e;
  }
  free() {
    let e = this.__destroy_into_raw();
    c();
    try {
      r.__wbg_containerstartupoptions_free(e, 0);
    } catch (t) {
      o(t);
    }
  }
  get enableInternet() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e;
    c();
    try {
      e = r.__wbg_get_containerstartupoptions_enableInternet(this.__wbg_ptr);
    } catch (t) {
      o(t);
    }
    return e === 16777215 ? void 0 : e !== 0;
  }
  get entrypoint() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e;
    c();
    try {
      e = r.__wbg_get_containerstartupoptions_entrypoint(this.__wbg_ptr);
    } catch (n) {
      o(n);
    }
    var t = _e(e[0], e[1]);
    return r.__wbindgen_free(e[0], e[1] * 4, 4), t;
  }
  get env() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e;
    c();
    try {
      e = r.__wbg_get_containerstartupoptions_env(this.__wbg_ptr);
    } catch (t) {
      o(t);
    }
    return e;
  }
  set enableInternet(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    c();
    try {
      r.__wbg_set_containerstartupoptions_enableInternet(this.__wbg_ptr, u(e) ? 16777215 : e ? 1 : 0);
    } catch (t) {
      o(t);
    }
  }
  set entrypoint(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let t = q(e, r.__wbindgen_malloc), n = l;
    c();
    try {
      r.__wbg_set_containerstartupoptions_entrypoint(this.__wbg_ptr, t, n);
    } catch (i) {
      o(i);
    }
  }
  set env(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    c();
    try {
      r.__wbg_set_containerstartupoptions_env(this.__wbg_ptr, e);
    } catch (t) {
      o(t);
    }
  }
};
Symbol.dispose && (v.prototype[Symbol.dispose] = v.prototype.free);
var A = class {
  static {
    __name(this, "A");
  }
  __destroy_into_raw() {
    let e = this.__wbg_ptr;
    return this.__wbg_ptr = 0, ae.unregister(this), e;
  }
  free() {
    let e = this.__destroy_into_raw();
    c();
    try {
      r.__wbg_intounderlyingbytesource_free(e, 0);
    } catch (t) {
      o(t);
    }
  }
  get autoAllocateChunkSize() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e;
    c();
    try {
      e = r.intounderlyingbytesource_autoAllocateChunkSize(this.__wbg_ptr);
    } catch (t) {
      o(t);
    }
    return e >>> 0;
  }
  cancel() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e = this.__destroy_into_raw();
    c();
    try {
      r.intounderlyingbytesource_cancel(e);
    } catch (t) {
      o(t);
    }
  }
  pull(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let t;
    c();
    try {
      t = r.intounderlyingbytesource_pull(this.__wbg_ptr, e);
    } catch (n) {
      o(n);
    }
    return t;
  }
  start(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    c();
    try {
      r.intounderlyingbytesource_start(this.__wbg_ptr, e);
    } catch (t) {
      o(t);
    }
  }
  get type() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e;
    c();
    try {
      e = r.intounderlyingbytesource_type(this.__wbg_ptr);
    } catch (t) {
      o(t);
    }
    return oe[e];
  }
};
Symbol.dispose && (A.prototype[Symbol.dispose] = A.prototype.free);
var z = class {
  static {
    __name(this, "z");
  }
  __destroy_into_raw() {
    let e = this.__wbg_ptr;
    return this.__wbg_ptr = 0, fe.unregister(this), e;
  }
  free() {
    let e = this.__destroy_into_raw();
    c();
    try {
      r.__wbg_intounderlyingsink_free(e, 0);
    } catch (t) {
      o(t);
    }
  }
  abort(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let t = this.__destroy_into_raw(), n;
    c();
    try {
      n = r.intounderlyingsink_abort(t, e);
    } catch (i) {
      o(i);
    }
    return n;
  }
  close() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e = this.__destroy_into_raw(), t;
    c();
    try {
      t = r.intounderlyingsink_close(e);
    } catch (n) {
      o(n);
    }
    return t;
  }
  write(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let t;
    c();
    try {
      t = r.intounderlyingsink_write(this.__wbg_ptr, e);
    } catch (n) {
      o(n);
    }
    return t;
  }
};
Symbol.dispose && (z.prototype[Symbol.dispose] = z.prototype.free);
var T = class {
  static {
    __name(this, "T");
  }
  __destroy_into_raw() {
    let e = this.__wbg_ptr;
    return this.__wbg_ptr = 0, be.unregister(this), e;
  }
  free() {
    let e = this.__destroy_into_raw();
    c();
    try {
      r.__wbg_intounderlyingsource_free(e, 0);
    } catch (t) {
      o(t);
    }
  }
  cancel() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e = this.__destroy_into_raw();
    c();
    try {
      r.intounderlyingsource_cancel(e);
    } catch (t) {
      o(t);
    }
  }
  pull(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let t;
    c();
    try {
      t = r.intounderlyingsource_pull(this.__wbg_ptr, e);
    } catch (n) {
      o(n);
    }
    return t;
  }
};
Symbol.dispose && (T.prototype[Symbol.dispose] = T.prototype.free);
var I = class {
  static {
    __name(this, "I");
  }
  __destroy_into_raw() {
    let e = this.__wbg_ptr;
    return this.__wbg_ptr = 0, ue.unregister(this), e;
  }
  free() {
    let e = this.__destroy_into_raw();
    c();
    try {
      r.__wbg_minifyconfig_free(e, 0);
    } catch (t) {
      o(t);
    }
  }
  get css() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e;
    c();
    try {
      e = r.__wbg_get_minifyconfig_css(this.__wbg_ptr);
    } catch (t) {
      o(t);
    }
    return e !== 0;
  }
  get html() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e;
    c();
    try {
      e = r.__wbg_get_minifyconfig_html(this.__wbg_ptr);
    } catch (t) {
      o(t);
    }
    return e !== 0;
  }
  get js() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e;
    c();
    try {
      e = r.__wbg_get_minifyconfig_js(this.__wbg_ptr);
    } catch (t) {
      o(t);
    }
    return e !== 0;
  }
  set css(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    c();
    try {
      r.__wbg_set_minifyconfig_css(this.__wbg_ptr, e);
    } catch (t) {
      o(t);
    }
  }
  set html(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    c();
    try {
      r.__wbg_set_minifyconfig_html(this.__wbg_ptr, e);
    } catch (t) {
      o(t);
    }
  }
  set js(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    c();
    try {
      r.__wbg_set_minifyconfig_js(this.__wbg_ptr, e);
    } catch (t) {
      o(t);
    }
  }
};
Symbol.dispose && (I.prototype[Symbol.dispose] = I.prototype.free);
var E = class {
  static {
    __name(this, "E");
  }
  __destroy_into_raw() {
    let e = this.__wbg_ptr;
    return this.__wbg_ptr = 0, we.unregister(this), e;
  }
  free() {
    let e = this.__destroy_into_raw();
    c();
    try {
      r.__wbg_r2range_free(e, 0);
    } catch (t) {
      o(t);
    }
  }
  get length() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e;
    c();
    try {
      e = r.__wbg_get_r2range_length(this.__wbg_ptr);
    } catch (t) {
      o(t);
    }
    return e[0] === 0 ? void 0 : e[1];
  }
  get offset() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e;
    c();
    try {
      e = r.__wbg_get_r2range_offset(this.__wbg_ptr);
    } catch (t) {
      o(t);
    }
    return e[0] === 0 ? void 0 : e[1];
  }
  get suffix() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e;
    c();
    try {
      e = r.__wbg_get_r2range_suffix(this.__wbg_ptr);
    } catch (t) {
      o(t);
    }
    return e[0] === 0 ? void 0 : e[1];
  }
  set length(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    c();
    try {
      r.__wbg_set_r2range_length(this.__wbg_ptr, !u(e), u(e) ? 0 : e);
    } catch (t) {
      o(t);
    }
  }
  set offset(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    c();
    try {
      r.__wbg_set_r2range_offset(this.__wbg_ptr, !u(e), u(e) ? 0 : e);
    } catch (t) {
      o(t);
    }
  }
  set suffix(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    c();
    try {
      r.__wbg_set_r2range_suffix(this.__wbg_ptr, !u(e), u(e) ? 0 : e);
    } catch (t) {
      o(t);
    }
  }
};
Symbol.dispose && (E.prototype[Symbol.dispose] = E.prototype.free);
var x = class {
  static {
    __name(this, "x");
  }
  __destroy_into_raw() {
    let e = this.__wbg_ptr;
    return this.__wbg_ptr = 0, Q.unregister(this), e;
  }
  free() {
    let e = this.__destroy_into_raw();
    c();
    try {
      r.__wbg_relaydevice_free(e, 0);
    } catch (t) {
      o(t);
    }
  }
  alarm() {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let e;
    c();
    try {
      e = r.relaydevice_alarm(this.__wbg_ptr);
    } catch (t) {
      o(t);
    }
    return e;
  }
  connect(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let t;
    c();
    try {
      t = r.relaydevice_connect(this.__wbg_ptr, e);
    } catch (n) {
      o(n);
    }
    return t;
  }
  fetch(e) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let t;
    c();
    try {
      t = r.relaydevice_fetch(this.__wbg_ptr, e);
    } catch (n) {
      o(n);
    }
    return t;
  }
  constructor(e, t) {
    let n;
    c();
    try {
      n = r.relaydevice_new(e, t);
    } catch (i) {
      o(i);
    }
    return this.__wbg_ptr = n, Object.defineProperty(this, "__wbg_inst", { value: s, writable: true }), Q.register(this, { ptr: n, instance: s }, this), this;
  }
  webSocketClose(e, t, n, i) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let f = m(n, r.__wbindgen_malloc, r.__wbindgen_realloc), a = l, b;
    c();
    try {
      b = r.relaydevice_webSocketClose(this.__wbg_ptr, e, t, f, a, i);
    } catch (d) {
      o(d);
    }
    return b;
  }
  webSocketError(e, t) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let n;
    c();
    try {
      n = r.relaydevice_webSocketError(this.__wbg_ptr, e, t);
    } catch (i) {
      o(i);
    }
    return n;
  }
  webSocketMessage(e, t) {
    if (this.__wbg_inst !== void 0 && this.__wbg_inst !== s) throw new Error("Invalid stale object from previous Wasm instance");
    let n;
    c();
    try {
      n = r.relaydevice_webSocketMessage(this.__wbg_ptr, e, t);
    } catch (i) {
      o(i);
    }
    return n;
  }
};
Symbol.dispose && (x.prototype[Symbol.dispose] = x.prototype.free);
function P() {
  s++, y = null, W = null, j = null, typeof numBytesDecoded < "u" && (numBytesDecoded = 0), typeof l < "u" && (l = 0), $ = false, O = false, N = new WebAssembly.Instance(Y, te()), r = N.exports, r.__wbindgen_start();
}
__name(P, "P");
function Z() {
  let _;
  c();
  try {
    _ = r.__worker_init_state();
  } catch (e) {
    o(e);
  }
  return _;
}
__name(Z, "Z");
function ee(_, e, t) {
  let n;
  c();
  try {
    n = r.fetch(_, e, t);
  } catch (i) {
    o(i);
  }
  return n;
}
__name(ee, "ee");
function te() {
  return { __proto__: null, "./index_bg.js": { __proto__: null, __wbg_String_8564e559799eccda: /* @__PURE__ */ __name(function(e, t) {
    let n = String(t), i = m(n, r.__wbindgen_malloc, r.__wbindgen_realloc), f = l;
    w().setInt32(e + 4, f, true), w().setInt32(e + 0, i, true);
  }, "__wbg_String_8564e559799eccda"), __wbg___wbindgen_debug_string_4687d8d8c2017d52: /* @__PURE__ */ __name(function(e, t) {
    let n = V(t), i = m(n, r.__wbindgen_malloc, r.__wbindgen_realloc), f = l;
    w().setInt32(e + 4, f, true), w().setInt32(e + 0, i, true);
  }, "__wbg___wbindgen_debug_string_4687d8d8c2017d52"), __wbg___wbindgen_is_function_1f9d30630b8b1d3d: /* @__PURE__ */ __name(function(e) {
    return typeof e == "function";
  }, "__wbg___wbindgen_is_function_1f9d30630b8b1d3d"), __wbg___wbindgen_is_null_or_undefined_f9435d56bdcc06df: /* @__PURE__ */ __name(function(e) {
    return e == null;
  }, "__wbg___wbindgen_is_null_or_undefined_f9435d56bdcc06df"), __wbg___wbindgen_is_undefined_8865fb403f8fe9d8: /* @__PURE__ */ __name(function(e) {
    return e === void 0;
  }, "__wbg___wbindgen_is_undefined_8865fb403f8fe9d8"), __wbg___wbindgen_reinit_3f79fdb34dee3ea9: /* @__PURE__ */ __name(function() {
    O = true;
  }, "__wbg___wbindgen_reinit_3f79fdb34dee3ea9"), __wbg___wbindgen_string_get_0380ccaa2f57f0d9: /* @__PURE__ */ __name(function(e, t) {
    let n = t, i = typeof n == "string" ? n : void 0;
    var f = u(i) ? 0 : m(i, r.__wbindgen_malloc, r.__wbindgen_realloc), a = l;
    w().setInt32(e + 4, a, true), w().setInt32(e + 0, f, true);
  }, "__wbg___wbindgen_string_get_0380ccaa2f57f0d9"), __wbg___wbindgen_throw_41e9ee4f547fc59a: /* @__PURE__ */ __name(function(e, t) {
    throw new WebAssembly.Exception(D, [new Error(h(e, t))]);
  }, "__wbg___wbindgen_throw_41e9ee4f547fc59a"), __wbg__wbg_cb_unref_dcc1a90847f04c41: /* @__PURE__ */ __name(function(e) {
    e._wbg_cb_unref();
  }, "__wbg__wbg_cb_unref_dcc1a90847f04c41"), __wbg_acceptWebSocket_fdf7466832747461: /* @__PURE__ */ __name(function(e, t, n, i) {
    var f = _e(n, i);
    r.__wbindgen_free(n, i * 4, 4), e.acceptWebSocket(t, f);
  }, "__wbg_acceptWebSocket_fdf7466832747461"), __wbg_body_4e088733babc630d: /* @__PURE__ */ __name(function(e) {
    let t = e.body;
    return u(t) ? 0 : g(t);
  }, "__wbg_body_4e088733babc630d"), __wbg_buffer_56ec2905a66f58b9: /* @__PURE__ */ __name(function(e) {
    return e.buffer;
  }, "__wbg_buffer_56ec2905a66f58b9"), __wbg_byobRequest_54f7ce41d584549a: /* @__PURE__ */ __name(function(e) {
    let t = e.byobRequest;
    return u(t) ? 0 : g(t);
  }, "__wbg_byobRequest_54f7ce41d584549a"), __wbg_byteLength_9f985b8373f1f3fe: /* @__PURE__ */ __name(function(e) {
    return e.byteLength;
  }, "__wbg_byteLength_9f985b8373f1f3fe"), __wbg_byteOffset_0bd5a6a03553639c: /* @__PURE__ */ __name(function(e) {
    return e.byteOffset;
  }, "__wbg_byteOffset_0bd5a6a03553639c"), __wbg_call_187d372bd5fdd4aa: /* @__PURE__ */ __name(function(e, t, n) {
    return e.call(t, n);
  }, "__wbg_call_187d372bd5fdd4aa"), __wbg_cause_19276d032a32d4bd: /* @__PURE__ */ __name(function(e) {
    return e.cause;
  }, "__wbg_cause_19276d032a32d4bd"), __wbg_cf_909bcfb212a8822c: /* @__PURE__ */ __name(function(e) {
    let t = e.cf;
    return u(t) ? 0 : g(t);
  }, "__wbg_cf_909bcfb212a8822c"), __wbg_cf_b47fe5ff6d015a0d: /* @__PURE__ */ __name(function(e) {
    let t = e.cf;
    return u(t) ? 0 : g(t);
  }, "__wbg_cf_b47fe5ff6d015a0d"), __wbg_close_150f701b1a60e0ac: /* @__PURE__ */ __name(function(e, t, n, i) {
    e.close(t, h(n, i));
  }, "__wbg_close_150f701b1a60e0ac"), __wbg_close_185286988f30f252: /* @__PURE__ */ __name(function(e) {
    e.close();
  }, "__wbg_close_185286988f30f252"), __wbg_close_748f26698dabe269: /* @__PURE__ */ __name(function(e) {
    e.close();
  }, "__wbg_close_748f26698dabe269"), __wbg_close_905cac8d4bb85f6f: /* @__PURE__ */ __name(function(e, t) {
    e.close(t);
  }, "__wbg_close_905cac8d4bb85f6f"), __wbg_close_d3ed56b5763be5ae: /* @__PURE__ */ __name(function(e) {
    e.close();
  }, "__wbg_close_d3ed56b5763be5ae"), __wbg_constructor_076176ce0f386e16: /* @__PURE__ */ __name(function(e) {
    return e.constructor;
  }, "__wbg_constructor_076176ce0f386e16"), __wbg_enqueue_4a01c128f9a0de16: /* @__PURE__ */ __name(function(e, t) {
    e.enqueue(t);
  }, "__wbg_enqueue_4a01c128f9a0de16"), __wbg_error_a30e98d44009f1bb: /* @__PURE__ */ __name(function(e, t) {
    console.error(e, t);
  }, "__wbg_error_a30e98d44009f1bb"), __wbg_error_c9cf3fc2064683a9: /* @__PURE__ */ __name(function(e) {
    console.error(e);
  }, "__wbg_error_c9cf3fc2064683a9"), __wbg_fetch_ae9b55b3c1c0b596: /* @__PURE__ */ __name(function(e, t) {
    return e.fetch(t);
  }, "__wbg_fetch_ae9b55b3c1c0b596"), __wbg_getTags_8acc26fb7a9cf1c0: /* @__PURE__ */ __name(function(e, t, n) {
    let i = t.getTags(n), f = q(i, r.__wbindgen_malloc), a = l;
    w().setInt32(e + 4, a, true), w().setInt32(e + 0, f, true);
  }, "__wbg_getTags_8acc26fb7a9cf1c0"), __wbg_getWebSockets_6e51c20f6a9c1765: /* @__PURE__ */ __name(function(e, t, n, i) {
    let f = t.getWebSockets(h(n, i)), a = q(f, r.__wbindgen_malloc), b = l;
    w().setInt32(e + 4, b, true), w().setInt32(e + 0, a, true);
  }, "__wbg_getWebSockets_6e51c20f6a9c1765"), __wbg_get_31af05bd4842a84f: /* @__PURE__ */ __name(function(e, t) {
    return Reflect.get(e, t);
  }, "__wbg_get_31af05bd4842a84f"), __wbg_get_806853698d9fc227: /* @__PURE__ */ __name(function(e, t) {
    return Reflect.get(e, t >>> 0);
  }, "__wbg_get_806853698d9fc227"), __wbg_get_88983e33467eae60: /* @__PURE__ */ __name(function(e, t) {
    let n = Reflect.get(e, t);
    return u(n) ? 0 : g(n);
  }, "__wbg_get_88983e33467eae60"), __wbg_get_f75619e20cb68514: /* @__PURE__ */ __name(function(e, t, n, i) {
    let f = t.get(h(n, i));
    var a = u(f) ? 0 : m(f, r.__wbindgen_malloc, r.__wbindgen_realloc), b = l;
    w().setInt32(e + 4, b, true), w().setInt32(e + 0, a, true);
  }, "__wbg_get_f75619e20cb68514"), __wbg_get_fc33ed5f5416f95a: /* @__PURE__ */ __name(function(e, t) {
    return e.get(t);
  }, "__wbg_get_fc33ed5f5416f95a"), __wbg_headers_6930a8bd09b630de: /* @__PURE__ */ __name(function(e) {
    return e.headers;
  }, "__wbg_headers_6930a8bd09b630de"), __wbg_headers_eba93595f8944c2f: /* @__PURE__ */ __name(function(e) {
    return e.headers;
  }, "__wbg_headers_eba93595f8944c2f"), __wbg_idFromName_de3147ec40aecd0e: /* @__PURE__ */ __name(function(e, t, n) {
    return e.idFromName(h(t, n));
  }, "__wbg_idFromName_de3147ec40aecd0e"), __wbg_instanceId_9b67ff33ae8bef8a: /* @__PURE__ */ __name(function(e) {
    return e.instanceId;
  }, "__wbg_instanceId_9b67ff33ae8bef8a"), __wbg_instanceof_Error_80a725f81f2e102d: /* @__PURE__ */ __name(function(e) {
    let t;
    try {
      t = e instanceof Error;
    } catch {
      t = false;
    }
    return t;
  }, "__wbg_instanceof_Error_80a725f81f2e102d"), __wbg_instanceof_Response_b8758567269c30b2: /* @__PURE__ */ __name(function(e) {
    let t;
    try {
      t = e instanceof Response;
    } catch {
      t = false;
    }
    return t;
  }, "__wbg_instanceof_Response_b8758567269c30b2"), __wbg_length_7f3c00c40364105e: /* @__PURE__ */ __name(function(e) {
    return e.length;
  }, "__wbg_length_7f3c00c40364105e"), __wbg_message_5f8387f0c32b90a7: /* @__PURE__ */ __name(function(e) {
    return e.message;
  }, "__wbg_message_5f8387f0c32b90a7"), __wbg_method_6d02ee0808a7de31: /* @__PURE__ */ __name(function(e, t) {
    let n = t.method, i = m(n, r.__wbindgen_malloc, r.__wbindgen_realloc), f = l;
    w().setInt32(e + 4, f, true), w().setInt32(e + 0, i, true);
  }, "__wbg_method_6d02ee0808a7de31"), __wbg_name_e2eac7cdfa054f65: /* @__PURE__ */ __name(function(e) {
    return e.name;
  }, "__wbg_name_e2eac7cdfa054f65"), __wbg_name_f9b814d78e8e299f: /* @__PURE__ */ __name(function(e) {
    return e.name;
  }, "__wbg_name_f9b814d78e8e299f"), __wbg_new_1dbf7428bba60a42: /* @__PURE__ */ __name(function(e) {
    return new Uint8Array(e);
  }, "__wbg_new_1dbf7428bba60a42"), __wbg_new_343a093a3c2ffb4e: /* @__PURE__ */ __name(function(e, t) {
    return new Error(h(e, t));
  }, "__wbg_new_343a093a3c2ffb4e"), __wbg_new_617a8cdb8bb1130e: /* @__PURE__ */ __name(function() {
    return new Object();
  }, "__wbg_new_617a8cdb8bb1130e"), __wbg_new_83ca405eae412a62: /* @__PURE__ */ __name(function() {
    return new Headers();
  }, "__wbg_new_83ca405eae412a62"), __wbg_new_a319c03ad1458611: /* @__PURE__ */ __name(function() {
    return new WebSocketPair();
  }, "__wbg_new_a319c03ad1458611"), __wbg_new_from_slice_9a868026ffa4208a: /* @__PURE__ */ __name(function(e, t) {
    return new Uint8Array(L(e, t));
  }, "__wbg_new_from_slice_9a868026ffa4208a"), __wbg_new_typed_b01cb72a8af741a3: /* @__PURE__ */ __name(function(e, t) {
    try {
      var n = { a: e, b: t }, i = /* @__PURE__ */ __name((a, b) => {
        let d = n.a;
        n.a = 0;
        try {
          return se(d, n.b, a, b);
        } finally {
          n.a = d;
        }
      }, "i");
      return new Promise(i);
    } finally {
      n.a = 0;
    }
  }, "__wbg_new_typed_b01cb72a8af741a3"), __wbg_new_with_byte_offset_and_length_2f5d7fc2a828b74d: /* @__PURE__ */ __name(function(e, t, n) {
    return new Uint8Array(e, t >>> 0, n >>> 0);
  }, "__wbg_new_with_byte_offset_and_length_2f5d7fc2a828b74d"), __wbg_new_with_length_3da0ad195f6f63ba: /* @__PURE__ */ __name(function(e) {
    return new Uint8Array(e >>> 0);
  }, "__wbg_new_with_length_3da0ad195f6f63ba"), __wbg_new_with_opt_buffer_source_and_init_c1b859a23c80afca: /* @__PURE__ */ __name(function(e, t) {
    return new Response(e, t);
  }, "__wbg_new_with_opt_buffer_source_and_init_c1b859a23c80afca"), __wbg_new_with_opt_readable_stream_and_init_df114f2d364f216d: /* @__PURE__ */ __name(function(e, t) {
    return new Response(e, t);
  }, "__wbg_new_with_opt_readable_stream_and_init_df114f2d364f216d"), __wbg_new_with_opt_str_and_init_33bef1b272950372: /* @__PURE__ */ __name(function(e, t, n) {
    return new Response(e === 0 ? void 0 : h(e, t), n);
  }, "__wbg_new_with_opt_str_and_init_33bef1b272950372"), __wbg_prototypesetcall_bc27214492979395: /* @__PURE__ */ __name(function(e, t, n) {
    Uint8Array.prototype.set.call(L(e, t), n);
  }, "__wbg_prototypesetcall_bc27214492979395"), __wbg_queueMicrotask_9833f9a49df95a49: /* @__PURE__ */ __name(function(e) {
    return e.queueMicrotask;
  }, "__wbg_queueMicrotask_9833f9a49df95a49"), __wbg_queueMicrotask_a72f977e97f23c5f: /* @__PURE__ */ __name(function(e) {
    queueMicrotask(e);
  }, "__wbg_queueMicrotask_a72f977e97f23c5f"), __wbg_readable_7c6bc793dd899969: /* @__PURE__ */ __name(function(e) {
    return e.readable;
  }, "__wbg_readable_7c6bc793dd899969"), __wbg_resolve_0076e10020304ede: /* @__PURE__ */ __name(function(e) {
    return Promise.resolve(e);
  }, "__wbg_resolve_0076e10020304ede"), __wbg_respond_c102fabcc79e5ef0: /* @__PURE__ */ __name(function(e, t) {
    e.respond(t >>> 0);
  }, "__wbg_respond_c102fabcc79e5ef0"), __wbg_send_797960c7a6a0270d: /* @__PURE__ */ __name(function(e, t) {
    e.send(t);
  }, "__wbg_send_797960c7a6a0270d"), __wbg_send_b5bdd806efe4baf6: /* @__PURE__ */ __name(function(e, t, n) {
    e.send(h(t, n));
  }, "__wbg_send_b5bdd806efe4baf6"), __wbg_set_145a351398b48c65: /* @__PURE__ */ __name(function(e, t, n) {
    return Reflect.set(e, t, n);
  }, "__wbg_set_145a351398b48c65"), __wbg_set_575d3ddb70fe831d: /* @__PURE__ */ __name(function(e, t, n) {
    e.set(L(t, n));
  }, "__wbg_set_575d3ddb70fe831d"), __wbg_set_criticalError_3904d60fe2a0b05b: /* @__PURE__ */ __name(function(e, t) {
    e.criticalError = t !== 0;
  }, "__wbg_set_criticalError_3904d60fe2a0b05b"), __wbg_set_headers_69ef7c46a2e6c742: /* @__PURE__ */ __name(function(e, t) {
    e.headers = t;
  }, "__wbg_set_headers_69ef7c46a2e6c742"), __wbg_set_instanceId_9ad5caac0a4e519c: /* @__PURE__ */ __name(function(e, t) {
    e.instanceId = t >>> 0;
  }, "__wbg_set_instanceId_9ad5caac0a4e519c"), __wbg_set_status_678f122cbe435d95: /* @__PURE__ */ __name(function(e, t) {
    e.status = t;
  }, "__wbg_set_status_678f122cbe435d95"), __wbg_static_accessor_GLOBAL_266715b9d96ba635: /* @__PURE__ */ __name(function() {
    let e = typeof global > "u" ? null : global;
    return u(e) ? 0 : g(e);
  }, "__wbg_static_accessor_GLOBAL_266715b9d96ba635"), __wbg_static_accessor_GLOBAL_THIS_10fb7dc1ae063179: /* @__PURE__ */ __name(function() {
    let e = typeof globalThis > "u" ? null : globalThis;
    return u(e) ? 0 : g(e);
  }, "__wbg_static_accessor_GLOBAL_THIS_10fb7dc1ae063179"), __wbg_static_accessor_INIT_STATE_e3fce2ad8a08e94e: /* @__PURE__ */ __name(function() {
    return K;
  }, "__wbg_static_accessor_INIT_STATE_e3fce2ad8a08e94e"), __wbg_static_accessor_SELF_0b583911f537483a: /* @__PURE__ */ __name(function() {
    let e = typeof self > "u" ? null : self;
    return u(e) ? 0 : g(e);
  }, "__wbg_static_accessor_SELF_0b583911f537483a"), __wbg_static_accessor_WINDOW_d7f903d1508cbdc4: /* @__PURE__ */ __name(function() {
    let e = typeof window > "u" ? null : window;
    return u(e) ? 0 : g(e);
  }, "__wbg_static_accessor_WINDOW_d7f903d1508cbdc4"), __wbg_status_ce0a98d3c57125f3: /* @__PURE__ */ __name(function(e) {
    return e.status;
  }, "__wbg_status_ce0a98d3c57125f3"), __wbg_then_c949d5a25a4e78f8: /* @__PURE__ */ __name(function(e, t, n) {
    return e.then(t, n);
  }, "__wbg_then_c949d5a25a4e78f8"), __wbg_then_e71170d78fcf8954: /* @__PURE__ */ __name(function(e, t) {
    return e.then(t);
  }, "__wbg_then_e71170d78fcf8954"), __wbg_url_7bfada5c2297bc70: /* @__PURE__ */ __name(function(e, t) {
    let n = t.url, i = m(n, r.__wbindgen_malloc, r.__wbindgen_realloc), f = l;
    w().setInt32(e + 4, f, true), w().setInt32(e + 0, i, true);
  }, "__wbg_url_7bfada5c2297bc70"), __wbg_view_9c570f33e8d6ab96: /* @__PURE__ */ __name(function(e) {
    let t = e.view;
    return u(t) ? 0 : g(t);
  }, "__wbg_view_9c570f33e8d6ab96"), __wbg_webSocket_2b7e8e9549bed673: /* @__PURE__ */ __name(function(e) {
    let t = e.webSocket;
    return u(t) ? 0 : g(t);
  }, "__wbg_webSocket_2b7e8e9549bed673"), __wbg_writable_a897472079c09078: /* @__PURE__ */ __name(function(e) {
    return e.writable;
  }, "__wbg_writable_a897472079c09078"), __wbindgen_generic_0000000000000001: /* @__PURE__ */ __name(function(e, t) {
    return le(e, t, ie);
  }, "__wbindgen_generic_0000000000000001"), __wbindgen_generic_0000000000000002: /* @__PURE__ */ __name(function(e, t) {
    return h(e, t);
  }, "__wbindgen_generic_0000000000000002"), __wbindgen_init_externref_table: /* @__PURE__ */ __name(function() {
    let e = r.__wbindgen_externrefs, t = e.grow(4);
    e.set(0, void 0), e.set(t + 0, void 0), e.set(t + 1, null), e.set(t + 2, true), e.set(t + 3, false);
  }, "__wbindgen_init_externref_table"), __wbindgen_jstag: WebAssembly.JSTag, __wbindgen_rethrow_critical: /* @__PURE__ */ __name(function(e) {
    throw new Error("Critical error", { cause: e });
  }, "__wbindgen_rethrow_critical") } };
}
__name(te, "te");
var D = new WebAssembly.Tag({ parameters: ["externref"] });
var J;
var $ = false;
function ne() {
  $ = true;
  try {
    let _ = B()[r.__abort_handler.value / 4];
    _ && r.__wbindgen_export.get(_)();
  } catch {
  }
}
__name(ne, "ne");
function o(_) {
  throw _ instanceof WebAssembly.Exception && _.is(D) ? _.getArg(D, 0) : (B()[J] = 1, ne(), _);
}
__name(o, "o");
function c() {
  if (J ??= r.__instance_terminated.value / 4, B()[J]) {
    if ($ || ne(), O) {
      P();
      return;
    }
    throw new Error("Module terminated");
  } else O && P();
}
__name(c, "c");
function ie(_, e, t) {
  let n;
  c();
  try {
    n = r.wasm_bindgen_46541003692460bc___convert__closures_____invoke___wasm_bindgen_46541003692460bc___JsValue__core_7a736bbbd1d104c3___result__Result_____wasm_bindgen_46541003692460bc___JsError___true_(_, e, t);
  } catch (i) {
    o(i);
  }
  if (n[1]) throw de(n[0]);
}
__name(ie, "ie");
function se(_, e, t, n) {
  c();
  try {
    r.wasm_bindgen_46541003692460bc___convert__closures_____invoke___js_sys_3b401d61faad6088___Function_fn_wasm_bindgen_46541003692460bc___JsValue_____wasm_bindgen_46541003692460bc___sys__Undefined___js_sys_3b401d61faad6088___Function_fn_wasm_bindgen_46541003692460bc___JsValue_____wasm_bindgen_46541003692460bc___sys__Undefined_______true_(_, e, t, n);
  } catch (i) {
    o(i);
  }
}
__name(se, "se");
var oe = ["bytes"];
var s = 0;
var ce = typeof FinalizationRegistry > "u" ? { register: /* @__PURE__ */ __name(() => {
}, "register"), unregister: /* @__PURE__ */ __name(() => {
}, "unregister") } : new FinalizationRegistry(({ ptr: _, instance: e }) => {
  e === s && r.__wbg_containerstartupoptions_free(_, 1);
});
var ae = typeof FinalizationRegistry > "u" ? { register: /* @__PURE__ */ __name(() => {
}, "register"), unregister: /* @__PURE__ */ __name(() => {
}, "unregister") } : new FinalizationRegistry(({ ptr: _, instance: e }) => {
  e === s && r.__wbg_intounderlyingbytesource_free(_, 1);
});
var fe = typeof FinalizationRegistry > "u" ? { register: /* @__PURE__ */ __name(() => {
}, "register"), unregister: /* @__PURE__ */ __name(() => {
}, "unregister") } : new FinalizationRegistry(({ ptr: _, instance: e }) => {
  e === s && r.__wbg_intounderlyingsink_free(_, 1);
});
var be = typeof FinalizationRegistry > "u" ? { register: /* @__PURE__ */ __name(() => {
}, "register"), unregister: /* @__PURE__ */ __name(() => {
}, "unregister") } : new FinalizationRegistry(({ ptr: _, instance: e }) => {
  e === s && r.__wbg_intounderlyingsource_free(_, 1);
});
var ue = typeof FinalizationRegistry > "u" ? { register: /* @__PURE__ */ __name(() => {
}, "register"), unregister: /* @__PURE__ */ __name(() => {
}, "unregister") } : new FinalizationRegistry(({ ptr: _, instance: e }) => {
  e === s && r.__wbg_minifyconfig_free(_, 1);
});
var we = typeof FinalizationRegistry > "u" ? { register: /* @__PURE__ */ __name(() => {
}, "register"), unregister: /* @__PURE__ */ __name(() => {
}, "unregister") } : new FinalizationRegistry(({ ptr: _, instance: e }) => {
  e === s && r.__wbg_r2range_free(_, 1);
});
var Q = typeof FinalizationRegistry > "u" ? { register: /* @__PURE__ */ __name(() => {
}, "register"), unregister: /* @__PURE__ */ __name(() => {
}, "unregister") } : new FinalizationRegistry(({ ptr: _, instance: e }) => {
  e === s && r.__wbg_relaydevice_free(_, 1);
});
function g(_) {
  let e = r.__externref_table_alloc();
  return r.__wbindgen_externrefs.set(e, _), e;
}
__name(g, "g");
var X = typeof FinalizationRegistry > "u" ? { register: /* @__PURE__ */ __name(() => {
}, "register"), unregister: /* @__PURE__ */ __name(() => {
}, "unregister") } : new FinalizationRegistry((_) => {
  _.instance === s && r.__wbindgen_destroy_closure(_.a, _.b);
});
function V(_) {
  let e = typeof _;
  if (e == "number" || e == "boolean" || _ == null) return `${_}`;
  if (e == "string") return `"${_}"`;
  if (e == "symbol") {
    let i = _.description;
    return i == null ? "Symbol" : `Symbol(${i})`;
  }
  if (e == "function") {
    let i = _.name;
    return typeof i == "string" && i.length > 0 ? `Function(${i})` : "Function";
  }
  if (Array.isArray(_)) {
    let i = _.length, f = "[";
    i > 0 && (f += V(_[0]));
    for (let a = 1; a < i; a++) f += ", " + V(_[a]);
    return f += "]", f;
  }
  let t = /\[object ([^\]]+)\]/.exec(toString.call(_)), n;
  if (t && t.length > 1) n = t[1];
  else return toString.call(_);
  if (n == "Object") try {
    return "Object(" + JSON.stringify(_) + ")";
  } catch {
    return "Object";
  }
  return _ instanceof Error ? `${_.name}: ${_.message}
${_.stack}` : n;
}
__name(V, "V");
function _e(_, e) {
  _ = _ >>> 0;
  let t = w(), n = [];
  for (let i = _; i < _ + 4 * e; i += 4) n.push(r.__wbindgen_externrefs.get(t.getUint32(i, true)));
  return r.__externref_drop_slice(_, e), n;
}
__name(_e, "_e");
function L(_, e) {
  return _ = _ >>> 0, S().subarray(_ / 1, _ / 1 + e);
}
__name(L, "L");
var y = null;
function w() {
  return (y === null || y.buffer.detached === true || y.buffer.detached === void 0 && y.buffer !== r.memory.buffer) && (y = new DataView(r.memory.buffer)), y;
}
__name(w, "w");
var W = null;
function B() {
  return (W === null || W.byteLength === 0) && (W = new Int32Array(r.memory.buffer)), W;
}
__name(B, "B");
function h(_, e) {
  return ge(_ >>> 0, e);
}
__name(h, "h");
var j = null;
function S() {
  return (j === null || j.byteLength === 0) && (j = new Uint8Array(r.memory.buffer)), j;
}
__name(S, "S");
function u(_) {
  return _ == null;
}
__name(u, "u");
function le(_, e, t) {
  let n = { a: _, b: e, cnt: 1, instance: s }, i = /* @__PURE__ */ __name((...f) => {
    if (n.instance !== s) throw new Error("Cannot invoke closure from previous WASM instance");
    n.cnt++;
    let a = n.a;
    n.a = 0;
    try {
      return t(a, n.b, ...f);
    } finally {
      n.a = a, i._wbg_cb_unref();
    }
  }, "i");
  return i._wbg_cb_unref = () => {
    --n.cnt === 0 && (r.__wbindgen_destroy_closure(n.a, n.b), n.a = 0, X.unregister(n));
  }, X.register(i, n, n), i;
}
__name(le, "le");
function q(_, e) {
  let t = e(_.length * 4, 4) >>> 0;
  for (let n = 0; n < _.length; n++) {
    let i = g(_[n]);
    w().setUint32(t + 4 * n, i, true);
  }
  return l = _.length, t;
}
__name(q, "q");
function m(_, e, t) {
  if (t === void 0) {
    let b = F.encode(_), d = e(b.length, 1) >>> 0;
    return S().subarray(d, d + b.length).set(b), l = b.length, d;
  }
  let n = _.length, i = e(n, 1) >>> 0, f = S(), a = 0;
  for (; a < n; a++) {
    let b = _.charCodeAt(a);
    if (b > 127) break;
    f[i + a] = b;
  }
  if (a !== n) {
    a !== 0 && (_ = _.slice(a)), i = t(i, n, n = a + _.length * 3, 1) >>> 0;
    let b = S().subarray(i + a, i + n), d = F.encodeInto(_, b);
    a += d.written, i = t(i, n, a, 1) >>> 0;
  }
  return l = a, i;
}
__name(m, "m");
var O = false;
function de(_) {
  let e = r.__wbindgen_externrefs.get(_);
  return r.__externref_table_dealloc(_), e;
}
__name(de, "de");
var re = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });
re.decode();
function ge(_, e) {
  return re.decode(S().subarray(_, _ + e));
}
__name(ge, "ge");
var F = new TextEncoder();
"encodeInto" in F || (F.encodeInto = function(_, e) {
  let t = F.encode(_);
  return e.set(t), { read: _.length, written: t.length };
});
var l = 0;
var N = new WebAssembly.Instance(Y, te());
var r = N.exports;
r.__wbindgen_start();
Error.stackTraceLimit = 100;
var p = Z();
function H() {
  p.criticalError && (console.log("Reinitializing Wasm application"), P(), p.criticalError = false, p.instanceId++);
}
__name(H, "H");
addEventListener("error", (_) => {
  G(_.error);
});
function G(_) {
  _ instanceof WebAssembly.RuntimeError && (console.error("Critical", _), p.criticalError = true);
}
__name(G, "G");
var M = class extends pe {
  static {
    __name(this, "M");
  }
};
M.prototype.fetch = function(e) {
  return ee.call(this, e, this.env, this.ctx);
};
var ye = { set: /* @__PURE__ */ __name((_, e, t, n) => Reflect.set(_.instance, e, t, n), "set"), has: /* @__PURE__ */ __name((_, e) => Reflect.has(_.instance, e), "has"), deleteProperty: /* @__PURE__ */ __name((_, e) => Reflect.deleteProperty(_.instance, e), "deleteProperty"), apply: /* @__PURE__ */ __name((_, e, t) => Reflect.apply(_.instance, e, t), "apply"), construct: /* @__PURE__ */ __name((_, e, t) => Reflect.construct(_.instance, e, t), "construct"), getPrototypeOf: /* @__PURE__ */ __name((_) => Reflect.getPrototypeOf(_.instance), "getPrototypeOf"), setPrototypeOf: /* @__PURE__ */ __name((_, e) => Reflect.setPrototypeOf(_.instance, e), "setPrototypeOf"), isExtensible: /* @__PURE__ */ __name((_) => Reflect.isExtensible(_.instance), "isExtensible"), preventExtensions: /* @__PURE__ */ __name((_) => Reflect.preventExtensions(_.instance), "preventExtensions"), getOwnPropertyDescriptor: /* @__PURE__ */ __name((_, e) => Reflect.getOwnPropertyDescriptor(_.instance, e), "getOwnPropertyDescriptor"), defineProperty: /* @__PURE__ */ __name((_, e, t) => Reflect.defineProperty(_.instance, e, t), "defineProperty"), ownKeys: /* @__PURE__ */ __name((_) => Reflect.ownKeys(_.instance), "ownKeys") };
var k = { construct(_, e, t) {
  try {
    H();
    let n = { instance: Reflect.construct(_, e, t), instanceId: p.instanceId, ctor: _, args: e, newTarget: t };
    return new Proxy(n, { ...ye, get(i, f, a) {
      i.instanceId !== p.instanceId && (i.instance = Reflect.construct(i.ctor, i.args, i.newTarget), i.instanceId = p.instanceId);
      let b = Reflect.get(i.instance, f, a);
      return typeof b != "function" ? b : b.constructor === Function ? new Proxy(b, { apply(d, C, U) {
        H();
        try {
          return d.apply(C, U);
        } catch (R) {
          throw G(R), R;
        }
      } }) : new Proxy(b, { async apply(d, C, U) {
        H();
        try {
          return await d.apply(C, U);
        } catch (R) {
          throw G(R), R;
        }
      } });
    } });
  } catch (n) {
    throw p.criticalError = true, n;
  }
} };
var xe = new Proxy(M, k);
var Re = new Proxy(v, k);
var We = new Proxy(I, k);
var je = new Proxy(E, k);
var Se = new Proxy(x, k);
export {
  Re as ContainerStartupOptions,
  We as MinifyConfig,
  je as R2Range,
  Se as RelayDevice,
  xe as default
};
//# sourceMappingURL=index.js.map
