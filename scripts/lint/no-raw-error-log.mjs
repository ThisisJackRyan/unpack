// ESLint rule unpack/no-raw-error-log: a caught error (the catch clause's
// binding, whatever its name) must not reach a log call except through
// safeErrorFields(...) (src/lib/safe-error-fields.ts). An error's message,
// stack, and cause can hold SQL, params, and personal data.
//
// It follows the binding, and values derived from it, to any argument of
// console.* or of a function whose name starts with "log" (log, logError,
// deps.log, logModelError...). Derived means: .message, .stack, .cause and
// the other error fields below, .toString(), a template literal, String(),
// JSON.stringify(), util.inspect() or util.format(), string concatenation,
// an object or array literal holding it ({ e }, { error: e }, [e], ...e),
// and a variable or assignment taking any of those. Passing it to any
// other function (safeErrorFields, questionErrorKind) ends the trail, as
// does reading a field like .kind, .code, .name, or .status, or a test
// like instanceof.
//
// A static check, and a practical one: the runtime guard is the console
// wrapper in src/lib/safe-console.ts, which every server log line goes
// through.

const SENSITIVE_FIELDS = new Set([
  "message",
  "stack",
  "cause",
  "errors",
  "sourceError",
  "detail",
  "hint",
  "where",
  "query",
  "params",
  "toString",
  "toLocaleString",
]);

// Calls that turn their argument into text: the text is as unsafe.
function isStringifyCall(call) {
  const { callee } = call;
  if (callee.type === "Identifier") return ["String", "inspect", "format", "formatWithOptions"].includes(callee.name);
  if (callee.type !== "MemberExpression" || callee.computed || callee.property.type !== "Identifier") return false;
  const object = callee.object.type === "Identifier" ? callee.object.name : "";
  const name = callee.property.name;
  return (object === "JSON" && name === "stringify") || (object === "util" && ["inspect", "format", "formatWithOptions"].includes(name));
}

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") return callee.property.name;
  return "";
}

function isLogCall(call) {
  const { callee } = call;
  if (callee.type === "MemberExpression" && callee.object.type === "Identifier" && callee.object.name === "console") return true;
  return /^log/.test(calleeName(callee));
}

const TRANSPARENT = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "ChainExpression",
  "AwaitExpression",
  "ParenthesizedExpression",
]);

// Climbs from a reference to the caught error (or a value derived from it)
// while the value stays unsafe. Returns where it ends up: a log call, a
// declaration or assignment to follow, or null (made safe or unused).
function climb(start, derivedAtStart) {
  let current = start;
  let derived = derivedAtStart;
  for (;;) {
    const parent = current.parent;
    if (!parent) return null;
    if (TRANSPARENT.has(parent.type)) {
      current = parent;
      continue;
    }
    switch (parent.type) {
      case "MemberExpression": {
        if (parent.object !== current) return null;
        const name = !parent.computed && parent.property.type === "Identifier" ? parent.property.name : null;
        // On text taken from the error, any method (slice, split) is
        // still that text; on the error itself, only its unsafe fields.
        if (derived ? name !== "length" : name === null || SENSITIVE_FIELDS.has(name)) {
          current = parent;
          derived = true;
          continue;
        }
        return null;
      }
      case "CallExpression":
      case "NewExpression": {
        if (parent.callee === current) {
          // e.toString(), e.message.slice(0, 80): the result is text.
          if (!derived) return null;
          current = parent;
          continue;
        }
        if (parent.type === "CallExpression" && isLogCall(parent)) return { log: parent };
        if (parent.type === "CallExpression" && isStringifyCall(parent)) {
          current = parent;
          derived = true;
          continue;
        }
        return null;
      }
      case "TemplateLiteral":
      case "ArrayExpression":
      case "ObjectExpression":
      case "SpreadElement":
        current = parent;
        continue;
      case "Property":
        if (parent.value !== current) return null;
        current = parent;
        continue;
      case "BinaryExpression":
        if (parent.operator !== "+") return null;
        current = parent;
        derived = true;
        continue;
      case "LogicalExpression":
        current = parent;
        continue;
      case "ConditionalExpression":
        if (parent.test === current) return null;
        current = parent;
        continue;
      case "VariableDeclarator":
        return parent.init === current ? { declare: parent, derived } : null;
      case "AssignmentExpression":
        return parent.right === current && parent.left.type === "Identifier" ? { assign: parent.left, derived } : null;
      default:
        return null;
    }
  }
}

function findVariable(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const variable = s.set.get(name);
    if (variable) return variable;
  }
  return null;
}

// The variables a declaration binds from an unsafe value: all of them for
// a plain name, array pattern, or rest; for an object pattern, the ones
// taken from an unsafe field (const { message } = e).
function boundNames(pattern, derived, out) {
  switch (pattern.type) {
    case "Identifier":
      out.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const prop of pattern.properties) {
        if (prop.type === "RestElement") boundNames(prop.argument, derived, out);
        else {
          const key = !prop.computed && prop.key.type === "Identifier" ? prop.key.name : null;
          if (derived || key === null || SENSITIVE_FIELDS.has(key)) boundNames(prop.value, true, out);
        }
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) if (element) boundNames(element, true, out);
      break;
    case "RestElement":
      boundNames(pattern.argument, true, out);
      break;
    case "AssignmentPattern":
      boundNames(pattern.left, derived, out);
      break;
  }
  return out;
}

/** @type {import("eslint").Rule.RuleModule} */
const rule = {
  meta: {
    type: "problem",
    docs: { description: "A caught error reaches a log call only through safeErrorFields(...)" },
    schema: [],
    messages: {
      raw: "The caught error `{{name}}` reaches this log call. Log safeErrorFields({{name}}) instead: an error's message, stack, and cause can hold SQL, params, and personal data.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      CatchClause(node) {
        if (!node.param) return;
        const caught = node.param.type === "Identifier" ? node.param.name : "error";
        // Each entry: a variable holding the error (derived false) or
        // something taken from it (derived true).
        const queue = sourceCode.getDeclaredVariables(node).map((variable) => ({
          variable,
          derived: node.param.type !== "Identifier",
        }));
        const seen = new Set();
        const reported = new Set();
        while (queue.length > 0) {
          const { variable, derived } = queue.pop();
          if (seen.has(variable)) continue;
          seen.add(variable);
          for (const reference of variable.references) {
            if (!reference.isRead()) continue;
            const end = climb(reference.identifier, derived);
            if (!end) continue;
            if (end.log) {
              if (reported.has(reference.identifier)) continue;
              reported.add(reference.identifier);
              context.report({ node: reference.identifier, messageId: "raw", data: { name: caught } });
            } else if (end.declare) {
              for (const declared of sourceCode.getDeclaredVariables(end.declare)) {
                if (boundNames(end.declare.id, end.derived, []).includes(declared.name)) {
                  queue.push({ variable: declared, derived: end.derived || end.declare.id.type !== "Identifier" });
                }
              }
            } else if (end.assign) {
              const target = findVariable(sourceCode.getScope(end.assign), end.assign.name);
              if (target) queue.push({ variable: target, derived: end.derived });
            }
          }
        }
      },
    };
  },
};

export default rule;
