// macOS temperature sensors without sudo: the IOHIDEventSystemClient API that Stats and macmon use, called through
// bun:ffi. Sensors are HID services with PrimaryUsagePage 0xff00 / PrimaryUsage 5; each one's temperature event
// (kIOHIDEventTypeTemperature = 15) carries °C as a float. Never powermetrics, never root.
//
// CF references are passed as u64 (bigint), never as `ptr` numbers: CoreFoundation hands out tagged pointers (small
// CFNumbers, short CFStrings) above 2^53 that a JS number would corrupt. Every buffer handed to native code as a
// `ptr()` stays referenced by a local until the call returns (a temporary could be collected mid-call). One reader per
// thread; the daemon runs it in a worker (thermal-client.ts) so a slow native call never blocks the event loop. Any
// failure to load releases what was created and disables the reader for good; callers get null ("n/a").
import { CString, dlopen, FFIType as T, ptr } from "bun:ffi";
import type { Sensor } from "./parse.ts";

const CF_PATH = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const IOKIT_PATH = "/System/Library/Frameworks/IOKit.framework/IOKit";
const LIBSYSTEM = "/usr/lib/libSystem.B.dylib";
const UTF8 = 0x08000100; // kCFStringEncodingUTF8
const CF_NUMBER_SINT32 = 3; // kCFNumberSInt32Type
const RTLD_NOW = 2;
const HID_EVENT_TEMPERATURE = 15;
const HID_TEMPERATURE_FIELD = HID_EVENT_TEMPERATURE << 16; // IOHIDEventFieldBase(kIOHIDEventTypeTemperature)
/** Re-enumerate sensors every this many reads (sensors can appear after wake; the list is cheap to rebuild). */
const REFRESH_EVERY = 20;

const R = T.u64;

function load() {
  const libc = dlopen(LIBSYSTEM, {
    dlopen: { args: [T.ptr, T.i32], returns: R },
    dlsym: { args: [R, T.ptr], returns: R },
    dlclose: { args: [R], returns: T.i32 },
  });
  const cf = dlopen(CF_PATH, {
    CFStringCreateWithCString: { args: [R, T.ptr, T.u32], returns: R },
    CFNumberCreate: { args: [R, T.i64, T.ptr], returns: R },
    CFDictionaryCreate: { args: [R, T.ptr, T.ptr, T.i64, R, R], returns: R },
    CFArrayGetCount: { args: [R], returns: T.i64 },
    CFArrayGetValueAtIndex: { args: [R, T.i64], returns: R },
    CFGetTypeID: { args: [R], returns: T.u64 },
    CFStringGetTypeID: { args: [], returns: T.u64 },
    CFStringGetCString: { args: [R, T.ptr, T.i64, T.u32], returns: T.bool },
    CFRelease: { args: [R], returns: T.void },
  });
  const io = dlopen(IOKIT_PATH, {
    IOHIDEventSystemClientCreate: { args: [R], returns: R },
    IOHIDEventSystemClientSetMatching: { args: [R, R], returns: T.i32 },
    IOHIDEventSystemClientCopyServices: { args: [R], returns: R },
    IOHIDServiceClientCopyProperty: { args: [R, R], returns: R },
    IOHIDServiceClientCopyEvent: { args: [R, T.i64, T.i32, T.i64], returns: R },
    IOHIDEventGetFloatValue: { args: [R, T.i32], returns: T.f64 },
  });
  return {
    libc: libc.symbols, cf: cf.symbols, io: io.symbols,
    /** Closes bun:ffi's handles on the three libraries (after dispose; the symbols are unusable afterwards). */
    close: (): void => { for (const l of [io, cf, libc]) l.close(); },
  };
}

/** The native calls the reader makes; tests pass a fake (test/unit/machine-stats-native.test.ts). */
export type ThermalLib = ReturnType<typeof load>;

const cstr = (s: string): Uint8Array => new TextEncoder().encode(s + "\0");

function asBig(v: unknown): bigint {
  return typeof v === "bigint" ? v : BigInt(Math.max(0, Number(v) || 0));
}

export class DarwinThermal {
  private readonly lib: ThermalLib;
  private client = 0n;
  /** The explicit dlopen handle used to look up the dictionary callbacks; dlclose'd on dispose. */
  private cfHandle = 0n;
  private productKey = 0n;
  private stringType = 0n;
  private readonly nameBuf = new Uint8Array(256);
  private services = 0n; // retained CFArray; the service refs we keep live inside it
  private selected: { ref: bigint; name: string }[] = [];
  private reads = 0;

  constructor(private readonly pick: (name: string) => boolean, lib: ThermalLib = load()) {
    this.lib = lib;
    try {
      this.init();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  private init(): void {
    const { cf, io, libc } = this.lib;
    const cfPath = cstr(CF_PATH);
    const keyCbName = cstr("kCFTypeDictionaryKeyCallBacks");
    const valCbName = cstr("kCFTypeDictionaryValueCallBacks");
    const handle = asBig(libc.dlopen(ptr(cfPath), RTLD_NOW));
    this.cfHandle = handle;
    const keyCb = handle ? asBig(libc.dlsym(handle, ptr(keyCbName))) : 0n;
    const valCb = handle ? asBig(libc.dlsym(handle, ptr(valCbName))) : 0n;
    if (!handle || !keyCb || !valCb) throw new Error("CoreFoundation callbacks not found");
    this.stringType = asBig(cf.CFStringGetTypeID());
    if (!this.stringType) throw new Error("CFStringGetTypeID failed");

    const created: bigint[] = []; // released below whatever happens: the dictionary retains what it needs
    try {
      const str = (s: string): bigint => {
        const buf = cstr(s);
        const ref = asBig(cf.CFStringCreateWithCString(0n, ptr(buf), UTF8));
        if (ref) created.push(ref);
        return ref;
      };
      const num = (v: number): bigint => {
        const buf = new Int32Array([v]);
        const ref = asBig(cf.CFNumberCreate(0n, CF_NUMBER_SINT32, ptr(buf)));
        if (ref) created.push(ref);
        return ref;
      };
      const keys = new BigUint64Array([str("PrimaryUsagePage"), str("PrimaryUsage")]);
      const vals = new BigUint64Array([num(0xff00), num(5)]);
      if ([...keys, ...vals].some((v) => v === 0n)) throw new Error("could not build the sensor matching dictionary");
      const matching = asBig(cf.CFDictionaryCreate(0n, ptr(keys), ptr(vals), 2, keyCb, valCb));
      if (!matching) throw new Error("CFDictionaryCreate failed");
      created.push(matching);
      this.client = asBig(io.IOHIDEventSystemClientCreate(0n));
      if (!this.client) throw new Error("IOHIDEventSystemClientCreate failed");
      io.IOHIDEventSystemClientSetMatching(this.client, matching);
    } finally {
      for (const ref of created) cf.CFRelease(ref);
    }
    const product = cstr("Product");
    this.productKey = asBig(cf.CFStringCreateWithCString(0n, ptr(product), UTF8));
    if (!this.productKey) throw new Error("could not build the Product key");
  }

  /** Releases every retained reference; the reader is unusable afterwards. Safe to call twice. */
  dispose(): void {
    const { cf, libc } = this.lib;
    for (const ref of [this.services, this.productKey, this.client]) if (ref) cf.CFRelease(ref);
    this.services = this.productKey = this.client = 0n;
    this.selected = [];
    if (this.cfHandle) (libc as { dlclose?: (h: bigint) => number }).dlclose?.(this.cfHandle);
    this.cfHandle = 0n;
  }

  /** dispose() and close the native libraries: the worker's last call before it exits (thermal-worker.ts). */
  close(): void {
    this.dispose();
    (this.lib as { close?: () => void }).close?.();
  }

  /** The service's "Product" name, or "" when it has none or it is not a CFString (never read as one). */
  private name(service: bigint): string {
    const { cf, io } = this.lib;
    const s = asBig(io.IOHIDServiceClientCopyProperty(service, this.productKey));
    if (!s) return "";
    try {
      if (asBig(cf.CFGetTypeID(s)) !== this.stringType) return "";
      const buf = this.nameBuf;
      return cf.CFStringGetCString(s, ptr(buf), buf.length, UTF8) ? new CString(ptr(buf)).toString() : "";
    } finally {
      cf.CFRelease(s);
    }
  }

  private enumerate(): void {
    const { cf, io } = this.lib;
    if (this.services) cf.CFRelease(this.services);
    this.services = 0n;
    this.selected = [];
    const arr = asBig(io.IOHIDEventSystemClientCopyServices(this.client));
    if (!arr) return;
    this.services = arr;
    const n = Math.min(512, Number(cf.CFArrayGetCount(arr)));
    for (let i = 0; i < n; i++) {
      const ref = asBig(cf.CFArrayGetValueAtIndex(arr, i));
      if (!ref) continue;
      const name = this.name(ref);
      if (this.pick(name)) this.selected.push({ ref, name });
    }
  }

  /** One reading per selected sensor (°C). */
  read(): Sensor[] {
    if (!this.client) throw new Error("thermal reader disposed");
    if (this.reads++ % REFRESH_EVERY === 0 || !this.selected.length) this.enumerate();
    const { cf, io } = this.lib;
    const out: Sensor[] = [];
    for (const s of this.selected) {
      const ev = asBig(io.IOHIDServiceClientCopyEvent(s.ref, HID_EVENT_TEMPERATURE, 0, 0));
      if (!ev) continue;
      try {
        out.push({ name: s.name, c: io.IOHIDEventGetFloatValue(ev, HID_TEMPERATURE_FIELD) });
      } finally {
        cf.CFRelease(ev);
      }
    }
    return out;
  }
}

let reader: DarwinThermal | null = null;
let failed: string | null = null;

/** Releases this thread's reader and closes its libraries; later reads report the reader closed. */
export function closeDarwinSensors(): void {
  const r = reader;
  reader = null;
  failed = "closed";
  r?.close();
}

/**
 * Current readings of the CPU/SoC sensors `pick` selects, or null when the API is unavailable (not macOS, the
 * frameworks or symbols missing, no sensors). The first failure is remembered: the API is not retried, and a reader
 * that failed mid-read is disposed.
 */
export function darwinSensors(pick: (name: string) => boolean): { sensors: Sensor[] | null; error: string | null } {
  if (process.platform !== "darwin") return { sensors: null, error: "not macOS" };
  if (failed) return { sensors: null, error: failed };
  try {
    reader ??= new DarwinThermal(pick);
    return { sensors: reader.read(), error: null };
  } catch (err) {
    failed = (err as Error).message;
    try { reader?.dispose(); } catch { /* already failing */ }
    reader = null;
    return { sensors: null, error: failed };
  }
}
