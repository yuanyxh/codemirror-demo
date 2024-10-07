/// Utility function for combining behaviors to fill in a config
/// object from an array of provided configs. `defaults` should hold
/// default values for all optional fields in `Config`.
///
/// The function will, by default, error
/// when a field gets two values that aren't `===`-equal, but you can
/// provide combine functions per field to do something else.
export function combineConfig<Config extends object>(
  configs: readonly Partial<Config>[],
  defaults: Partial<Config>, // Should hold only the optional properties of Config, but I haven't managed to express that
  combine: {[P in keyof Config]?: (first: Config[P], second: Config[P]) => Config[P]} = {}
): Config {
  const result: any = {}
  for (const config of configs) for (const key of Object.keys(config) as (keyof Config)[]) {
    const value = config[key], current = result[key]
    if (current === undefined) result[key] = value
    else if (current === value || value === undefined) {} // No conflict
    else if (Object.hasOwnProperty.call(combine, key)) result[key] = combine[key]!(current as any, value as any)
    else throw new Error("Config merge conflict for field " + (key as string))
  }
  for (const key in defaults) if (result[key] === undefined) result[key] = defaults[key]
  return result
}
