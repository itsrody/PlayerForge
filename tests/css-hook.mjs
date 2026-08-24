/**
 * Node has no CSS module support; the esbuild bundle inlines styles.css, so
 * under node --test we short-circuit any .css import to an empty default.
 */
export async function resolve(specifier, context, next) {
  if (specifier.endsWith(".css")) {
    return { shortCircuit: true, url: "data:text/javascript,export default ''" };
  }
  return next(specifier, context);
}
