/**
 * PlayerForge's own lint rules.
 *
 * pf/no-forced-layout implements the one §5 invariant whose stated
 * verification did not exist yet: "No forced synchronous layout — lint rule
 * banning a layout-property read in the same task as its write".
 *
 * A layout write dirties the box tree; a geometric read taken before that
 * dirt settles forces the engine to run layout synchronously to answer it.
 * That flush is the synchronous work §1 rules out, and it is invisible to
 * every other check in this repo because it is not a wrong answer, only a
 * slow one. Read-then-write is not the same thing: it flushes the previous
 * state, which the engine had to have anyway, and it is allowed here for that
 * reason.
 *
 * "Same task" is approximated syntactically, because that is all a lint rule
 * can see:
 *
 *   - one function body (or Program, or class static block) at a time, not
 *     descending into nested functions. A callback is its own task even when
 *     it is created here, and the commits L4 issues are exactly that — the
 *     write lands in a different task from the one that raised it, which is
 *     why routing a site through the gate is the fix rather than a
 *     suppression;
 *   - stopping at the first `await`, which is a task boundary by
 *     construction;
 *   - the write must come first in source order. A write in the enclosing
 *     function is not counted against a nested reader, so some real
 *     violations are missed. That is the deliberate direction to be wrong in:
 *     a lint rule with false positives taxes every future change, while a
 *     false negative only leaves the status quo in place.
 *
 * `getComputedStyle()` is deliberately not a blanket read. Resolved-value
 * reads only force layout for properties whose value depends on geometry, and
 * the two call sites in src/ read `position` and `transform`, neither of which
 * does — flagging the call would burn the rule's credibility on an invariant
 * it does not actually describe. The chained geometry form
 * (`getComputedStyle(el).width`) is caught, because that one does flush.
 */

const LAYOUT_PROPS = new Set([
  "offsetWidth", "offsetHeight", "offsetTop", "offsetLeft",
  "clientWidth", "clientHeight",
  "scrollWidth", "scrollHeight", "scrollLeft", "scrollTop"
]);

const READ_METHODS = new Set(["getBoundingClientRect", "getClientRects"]);

/** Geometry off a resolved-value style read: this form does flush. */
const STYLE_GEOMETRY = new Set([
  "width", "height", "top", "right", "bottom", "left",
  "marginTop", "marginRight", "marginBottom", "marginLeft",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"
]);

/** Assignments that dirty layout without going through `.style`. */
const WRITTEN_PROPS = new Set(["className", "hidden", "textContent", "innerHTML", "outerHTML", "style"]);

/** Attributes that change how the box is laid out. */
const LAYOUT_ATTRS = new Set(["class", "style", "hidden", "width", "height"]);

const DOM_MUTATIONS = new Set([
  "append", "appendChild", "prepend", "insertBefore", "remove", "removeChild",
  "replaceWith", "replaceChildren", "insertAdjacentHTML", "insertAdjacentElement",
  "before", "after"
]);

const FUNCTION_LIKE = new Set([
  "FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"
]);

const prop = (node) => {
  if (!node || node.type !== "MemberExpression") return null;
  if (node.computed) return node.property.type === "Literal" && typeof node.property.value === "string" ? node.property.value : null;
  return node.property.type === "Identifier" ? node.property.name : null;
};

const isStyleObject = (node) => node?.type === "MemberExpression" && !node.computed && node.property.type === "Identifier" && node.property.name === "style";

/** Called member name, whether the callee is `el.foo` or a bare `foo`. */
const calleeName = (call) => (call.callee.type === "Identifier" ? call.callee.name : prop(call.callee));

/** Does this expression dirty layout when it finishes evaluating? */
function isLayoutWrite(node) {
  if (node.type === "AssignmentExpression") {
    const left = node.left;
    if (left.type !== "MemberExpression") return false;
    // a.style = "..." and a.style.width = "..." both dirty the box tree.
    if (isStyleObject(left) || isStyleObject(left.object)) return true;
    return WRITTEN_PROPS.has(prop(left));
  }
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  const method = callee.property.type === "Identifier" ? callee.property.name : null;
  if (!method) return false;
  if (method === "setProperty") return isStyleObject(callee.object);
  if (method === "classList" || isStyleObject(callee.object)) return false;
  // el.classList.add(...)
  if (callee.object.type === "MemberExpression" && prop(callee.object) === "classList") return true;
  if (DOM_MUTATIONS.has(method)) return true;
  if (method === "setAttribute" || method === "removeAttribute" || method === "toggleAttribute") {
    const first = node.arguments[0];
    return Boolean(first && first.type === "Literal" && LAYOUT_ATTRS.has(first.value));
  }
  return false;
}

/** Does this node force layout to answer? Read-then-write is not caught. */
function isLayoutRead(node) {
  if (node.type === "CallExpression") return READ_METHODS.has(calleeName(node));
  if (node.type !== "MemberExpression") return false;
  const name = prop(node);
  if (name && LAYOUT_PROPS.has(name)) return true;
  if (name && STYLE_GEOMETRY.has(name)) {
    // Only getComputedStyle(x).geometry — `video.width` reflects an attribute
    // and reads no layout.
    return node.object.type === "CallExpression" && calleeName(node.object) === "getComputedStyle";
  }
  return false;
}

/** Walk `root`'s own extent in evaluation order, reporting the first read-after-write. */
function checkScope(context, root) {
  const sourceCode = context.sourceCode;
  let write = null;
  let reported = false;

  const visit = (node) => {
    if (!node || reported || typeof node.type !== "string") return;
    if (node !== root && FUNCTION_LIKE.has(node.type)) return;
    if (node.type === "StaticBlock" && node !== root) return;

    if (write && isLayoutRead(node)) {
      reported = true;
      context.report({
        node,
        message: "Layout property read after a layout write in the same task. "
          + "The read forces layout to settle '{{write}}'. Route the write through "
          + "the RenderGate, or move the read across a task boundary (await / commit).",
        data: { write: sourceCode.getText(write).replace(/\s+/g, " ").slice(0, 60) }
      });
      return;
    }

    if (node.type === "AwaitExpression") {
      // The awaited expression still runs in this task; its continuation does
      // not, which is where the boundary goes.
      visit(node.argument);
      write = null;
      return;
    }

    if (node.type === "AssignmentExpression") {
      visit(node.right);
      if (isLayoutWrite(node)) write = node;
      return;
    }
    if (node.type === "UpdateExpression") {
      // el.scrollTop++ reads and writes; treated as the write it ends as.
      if (isLayoutWrite(node.argument)) write = node;
      return;
    }

    for (const key of Object.keys(node)) {
      if (key === "parent" || key === "range" || key === "loc") continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) visit(child);
      } else if (value && typeof value.type === "string") {
        visit(value);
      }
    }

    if (isLayoutWrite(node)) write = node;
  };

  visit(root);
}

export const pfRules = {
  "no-forced-layout": {
    meta: {
      type: "problem",
      docs: {
        description: "ban a layout-property read in the same task as a layout write (§5 performance invariants)"
      },
      schema: []
    },
    create(context) {
      const run = (node) => checkScope(context, node);
      return {
        Program: run,
        FunctionDeclaration: run,
        FunctionExpression: run,
        ArrowFunctionExpression: run,
        StaticBlock: run
      };
    }
  }
};
