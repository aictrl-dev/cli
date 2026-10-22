const epoch = 1792584000000 // 2026-10-21T12:00:00.000Z
const NativeDate = Date
globalThis.Date = new Proxy(NativeDate, {
  construct(target, args, next) {
    return Reflect.construct(target, args.length ? args : [epoch], next)
  },
  apply() {
    return new NativeDate(epoch).toString()
  },
  get(target, key, receiver) {
    return key === "now" ? () => epoch : Reflect.get(target, key, receiver)
  },
})
