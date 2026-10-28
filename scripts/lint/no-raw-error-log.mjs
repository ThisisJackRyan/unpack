// ESLint rule unpack/no-raw-error-log: a caught error must not reach a log
// call except through safeErrorFields(...) (src/lib/safe-error-fields.ts).
// An error's message, stack, and cause can hold SQL, params, and personal
// data.
//
// Where a caught error comes from:
// - a catch clause's binding, whatever its name;
// - the first parameter of a promise's rejection handler:
//   p.catch((e) => ...) and p.then(onOk, (e) => ...);
// - the first parameter of an onError or onFailure callback (an object
//   property, also with a quoted or computed literal key, or a JSX
//   attribute), whatever the parameter is called. A callback that gets
//   safe fields from its producer is named onErrorFields or
//   onFailureFields instead (student-questions-core.ts,
//   self-questions-core.ts, join-bot-check.ts), and isn't tracked: the
//   producer's name for it says what it passes, not the consumer's
//   parameter name;
// - the first parameter of an "error", "uncaughtException", or
//   "unhandledRejection" listener (.on, .once, .addListener,
//   .addEventListener).
//
// Where it must not go (a log call):
// - console.*, also through an alias (const log = console.error;
//   const c = console; const { error } = console; console.error.bind(...);
//   globalThis.console);
// - process.stderr.write and process.stdout.write, also aliased;
// - a function whose name starts with "log" (log, logError, deps.log,
//   logModelError...).
//
// It follows the error, and values derived from it, to those calls.
// Derived means: .message, .stack, .cause and the other error fields
// below, .toString(), a template literal, String(), JSON.stringify(),
// util.inspect() or util.format(), string concatenation, an object or
// array literal holding it ({ e }, { error: e }, [e], ...e) and anything
// read from that literal, new Error("...", { cause: e }) or any other
// new X(..., e), Object.assign, Object.entries/values/fromEntries,
// structuredClone, Array.from, JSON.parse, a variable or assignment
// taking any of those, obj.field = e (obj is then unsafe), and
// list.push(e) or map.set(k, e) (the list or map is then unsafe).
//
// Closures and helpers in the same file are followed too:
// - a local function (a function declaration, or a const holding an
//   arrow or function expression) that gets the error as an argument:
//   its parameter is followed inside it, so a helper that logs it is
//   reported there, and a helper that returns it (an identity helper)
//   makes that call's result unsafe;
// - a function that returns the error (const get = () => e) makes every
//   call of it unsafe;
// - a .catch or .then handler that returns the error makes the promise
//   chain's result unsafe.
//
// Passing it to any other function (safeErrorFields, questionErrorKind,
// an imported helper) ends the trail, as does reading a field like .kind,
// .code, .name, or .status, or a test like instanceof.
//
// Limits (a static check, without types): it doesn't follow a helper
// imported from another file, a function passed by name as a callback
// (p.catch(handle)), a callback parameter not listed above, a method on a
// class or object, a value stored in a module-level structure and read
// elsewhere, array methods on a list holding the error ([e].map(...)),
// computed property names other than a string literal, a rejection read
// from Promise.allSettled's results (r.reason), or a log call made through
// Reflect.apply(console.error, console, [e]). The runtime guard is the
// console wrapper in src/lib/safe-console.ts, which every server log line
// goes through.

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

const CALLBACK_KEYS = new Set(["onError", "onFailure"]);
const ERROR_EVENTS = new Set(["error", "uncaughtException", "unhandledRejection"]);
const LISTENER_METHODS = new Set(["on", "once", "addListener", "prependListener", "prependOnceListener", "addEventListener"]);
// Calls whose result holds their unsafe argument.
const PASS_THROUGH = new Set([
  "Object.assign",
  "Object.entries",
  "Object.values",
  "Object.fromEntries",
  "structuredClone",
  "Array.from",
  "Array.of",
  "JSON.parse",
]);
// Methods that store their argument in the object they're called on.
const STORING_METHODS = new Set(["push", "unshift", "set", "add"]);
const GLOBAL_PREFIX = /^(globalThis|window|self|global)\./;
// How many local helpers deep it follows the error (and stops a helper
// that calls itself).
const MAX_HELPER_DEPTH = 4;
// A holder whose key for the error isn't known.
const ANY_KEY = "*";

// A stable id per AST node or scope variable, for the visited set.
const ids = new WeakMap();
let nextId = 0;
function idOf(object) {
  if (!ids.has(object)) ids.set(object, (nextId += 1));
  return ids.get(object);
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

function unwrap(node) {
  let current = node;
  while (current && TRANSPARENT.has(current.type)) current = current.expression ?? current.argument;
  return current;
}

function isFunction(node) {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression" || node?.type === "FunctionDeclaration";
}

function propertyName(member) {
  if (member.type !== "MemberExpression") return null;
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  if (member.computed && member.property.type === "Literal" && typeof member.property.value === "string") return member.property.value;
  return null;
}

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  return propertyName(callee) ?? "";
}

function findVariable(scope, name) {
  for (let s = scope; s; s = s.upper) {
    const variable = s.set.get(name);
    if (variable) return variable;
  }
  return null;
}

/** @param {import("eslint").Rule.RuleContext} context */
function makeHelpers(context) {
  const { sourceCode } = context;

  // What an expression stands for, as a dotted path from a global:
  // "console.error", "process.stderr.write". Follows const aliases and
  // destructuring. Null for anything else (a parameter, an import).
  function resolvePath(node, hops = 0) {
    const target = unwrap(node);
    if (!target || hops > 8) return null;
    if (target.type === "Identifier") {
      const variable = findVariable(sourceCode.getScope(target), target.name);
      if (!variable || variable.defs.length === 0) return target.name;
      const def = variable.defs[0];
      // import { inspect } from "node:util": the name it was imported as.
      if (def.type === "ImportBinding") return target.name;
      if (def.type !== "Variable" || !def.node.init) return null;
      const declarator = def.node;
      if (declarator.id.type === "Identifier") return resolvePath(declarator.init, hops + 1);
      if (declarator.id.type !== "ObjectPattern") return null;
      const base = resolvePath(declarator.init, hops + 1);
      if (!base) return null;
      for (const prop of declarator.id.properties) {
        if (prop.type !== "Property" || prop.computed || prop.key.type !== "Identifier") continue;
        const bound = prop.value.type === "AssignmentPattern" ? prop.value.left : prop.value;
        if (bound.type === "Identifier" && bound.name === target.name) return `${base}.${prop.key.name}`;
      }
      return null;
    }
    if (target.type === "MemberExpression") {
      const name = propertyName(target);
      const base = name === null ? null : resolvePath(target.object, hops + 1);
      return base ? `${base}.${name}`.replace(GLOBAL_PREFIX, "") : null;
    }
    // console.error.bind(console)
    if (target.type === "CallExpression" && propertyName(target.callee) === "bind") return resolvePath(target.callee.object, hops + 1);
    return null;
  }

  function isLogCall(call) {
    const path = resolvePath(call.callee);
    if (path && (path.startsWith("console.") || path === "process.stderr.write" || path === "process.stdout.write")) return true;
    return /^log/.test(calleeName(call.callee));
  }

  // Calls that turn their argument into text: the text is as unsafe.
  function isStringifyCall(call) {
    const path = resolvePath(call.callee) ?? "";
    return ["String", "inspect", "format", "formatWithOptions", "JSON.stringify", "util.inspect", "util.format", "util.formatWithOptions"].includes(path);
  }

  function isPassThroughCall(call) {
    return PASS_THROUGH.has(resolvePath(call.callee) ?? "");
  }

  // The function a call's callee names, when it is defined in this file:
  // a function declaration, or a const holding an arrow or function.
  function localFunction(callee) {
    if (callee.type !== "Identifier") return null;
    const variable = findVariable(sourceCode.getScope(callee), callee.name);
    const def = variable?.defs[0];
    if (!def) return null;
    if (def.type === "FunctionName" && isFunction(def.node)) return def.node;
    if (def.type === "Variable" && isFunction(def.node.init) && def.node.parent.kind === "const") return def.node.init;
    return null;
  }

  // The variables a function's index-th parameter binds, and whether
  // they hold the value itself (false) or parts of it (true).
  function paramVariables(fn, index) {
    const param = fn.params[index];
    if (!param) return [];
    const inParam = (v) => v.defs.some((d) => d.type === "Parameter" && d.name.range[0] >= param.range[0] && d.name.range[1] <= param.range[1]);
    const derived = param.type !== "Identifier" && !(param.type === "AssignmentPattern" && param.left.type === "Identifier");
    return sourceCode.getDeclaredVariables(fn).filter(inParam).map((variable) => ({ variable, derived }));
  }

  // The variable a function is bound to (function f() {}, const f = () => ...).
  function functionVariable(fn) {
    if (fn.type === "FunctionDeclaration" && fn.id) return sourceCode.getDeclaredVariables(fn).find((v) => v.name === fn.id.name) ?? null;
    const parent = fn.parent;
    if (parent?.type === "VariableDeclarator" && parent.init === fn && parent.id.type === "Identifier") {
      return sourceCode.getDeclaredVariables(parent).find((v) => v.name === parent.id.name) ?? null;
    }
    return null;
  }

  return { isLogCall, isStringifyCall, isPassThroughCall, localFunction, paramVariables, functionVariable, resolvePath };
}

function propertyKey(property) {
  if (property.key.type === "Identifier") return property.key.name;
  if (property.key.type === "Literal") return String(property.key.value);
  return ANY_KEY;
}

function enclosingFunction(node) {
  for (let current = node.parent; current; current = current.parent) if (isFunction(current)) return current;
  return null;
}

// The variable at the root of obj.a.b, when it is a plain identifier.
function rootIdentifier(node) {
  let current = unwrap(node);
  while (current?.type === "MemberExpression") current = unwrap(current.object);
  return current?.type === "Identifier" ? current : null;
}

// Climbs from a reference to the caught error (or a value derived from it)
// while the value stays unsafe. Returns where it ends up: a log call, a
// declaration or assignment to follow, a local function it enters or
// returns from, something that now holds it, or null (made safe or
// unused).
//
// derived: the value is taken from the error (its text, a field), so
// anything read from it is unsafe too. holder: the value holds the error:
// the key it is under ({ error: e } gives "error"), or ANY_KEY when that
// isn't known (an array, a spread, a nested literal, new X(e)), or false.
function climb(start, derivedAtStart, holderAtStart, helpers) {
  let current = start;
  let derived = derivedAtStart;
  let holder = holderAtStart;
  // The key of the property just climbed through.
  let key = null;
  for (;;) {
    const parent = current.parent;
    if (!parent) return null;
    if (TRANSPARENT.has(parent.type)) {
      current = parent;
      continue;
    }
    const lastKey = key;
    key = null;
    switch (parent.type) {
      case "MemberExpression": {
        if (parent.object !== current) return null;
        const name = propertyName(parent);
        // Read from something holding the error: its key gives the error
        // itself; any other key is something else.
        if (holder === ANY_KEY) {
          current = parent;
          continue;
        }
        if (holder) {
          if (name !== holder) return null;
          current = parent;
          holder = false;
          continue;
        }
        // On text taken from the error, any field or method is still
        // unsafe; on the error itself, only its unsafe fields.
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
          holder = false;
          continue;
        }
        if (parent.type === "NewExpression") {
          // new Error("wrap", { cause: e }), new Map([[k, e]]): holds it.
          current = parent;
          holder = ANY_KEY;
          continue;
        }
        if (helpers.isLogCall(parent)) return { log: parent };
        if (helpers.isStringifyCall(parent)) {
          current = parent;
          derived = true;
          holder = false;
          continue;
        }
        if (helpers.isPassThroughCall(parent)) {
          // Object.assign(target, e): the target holds it too.
          const target = parent.arguments[0] !== current ? rootIdentifier(parent.arguments[0]) : null;
          return { holds: parent, target };
        }
        const method = propertyName(parent.callee);
        if (method && STORING_METHODS.has(method)) {
          const target = rootIdentifier(parent.callee.object);
          return target ? { stored: target } : null;
        }
        const fn = helpers.localFunction(parent.callee);
        const index = parent.arguments.indexOf(current);
        if (fn && index >= 0 && !parent.arguments.slice(0, index).some((a) => a.type === "SpreadElement")) {
          return { enter: fn, index, call: parent, derived, holder };
        }
        return null;
      }
      case "ArrowFunctionExpression":
        return parent.body === current ? { returns: parent, derived, holder } : null;
      case "ReturnStatement": {
        const fn = enclosingFunction(parent);
        return fn ? { returns: fn, derived, holder } : null;
      }
      case "TemplateLiteral":
        current = parent;
        derived = true;
        holder = false;
        continue;
      case "SpreadElement":
        current = parent;
        continue;
      case "ArrayExpression":
        current = parent;
        holder = ANY_KEY;
        continue;
      case "ObjectExpression":
        current = parent;
        holder = holder === false && lastKey !== null ? lastKey : ANY_KEY;
        continue;
      case "Property":
        if (parent.value !== current) return null;
        current = parent;
        key = parent.computed ? ANY_KEY : propertyKey(parent);
        continue;
      case "BinaryExpression":
        if (parent.operator !== "+") return null;
        current = parent;
        derived = true;
        holder = false;
        continue;
      case "LogicalExpression":
        current = parent;
        continue;
      case "ConditionalExpression":
        if (parent.test === current) return null;
        current = parent;
        continue;
      case "VariableDeclarator":
        return parent.init === current ? { declare: parent, derived, holder } : null;
      case "AssignmentExpression": {
        if (parent.right !== current) return null;
        if (parent.left.type === "Identifier") return { assign: parent.left, derived, holder };
        // obj.error = e: obj now holds it.
        const target = rootIdentifier(parent.left);
        return target ? { stored: target } : null;
      }
      default:
        return null;
    }
  }
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

// The variables a declaration binds from something holding the error:
// the one under its key, or all of them for ANY_KEY.
function holderNames(pattern, holder, out) {
  if (pattern.type !== "ObjectPattern" || holder === ANY_KEY) return boundNames(pattern, true, out);
  for (const prop of pattern.properties) {
    if (prop.type === "RestElement" || prop.computed || propertyKey(prop) === holder) boundNames(prop.type === "RestElement" ? prop.argument : prop.value, true, out);
  }
  return out;
}

function paramLabel(param) {
  if (param?.type === "Identifier") return param.name;
  if (param?.type === "AssignmentPattern" && param.left.type === "Identifier") return param.left.name;
  return "error";
}

// An onError or onFailure key: { onError }, { "onError" }, { ["onError"] }.
function isCallbackKey(property) {
  const { key } = property;
  if (!property.computed && key.type === "Identifier") return CALLBACK_KEYS.has(key.name);
  if (key.type === "Literal" && typeof key.value === "string") return CALLBACK_KEYS.has(key.value);
  if (key.type === "TemplateLiteral" && key.expressions.length === 0) return CALLBACK_KEYS.has(key.quasis[0].value.cooked);
  return false;
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
    const helpers = makeHelpers(context);
    const reported = new Set();

    // Follows one source of a caught error to every log call it reaches.
    function track(initial, name) {
      // Each task: a variable holding the error (derived false), something
      // taken from it (derived true), or a literal holding it (holder
      // true); or an expression node to climb from. returnTo: the chain of
      // local helper calls entered on the way ({ call, outer }), where a
      // value a helper returns comes out.
      const queue = initial.map((task) => ({ holder: false, returnTo: null, ...task }));
      const seen = new Set();
      const keyOf = (task) => [task.variable ?? task.node, task.derived, task.holder, task.returnTo?.call];
      const visited = (task) => {
        const key = JSON.stringify(keyOf(task).map((part) => (part && typeof part === "object" ? idOf(part) : part)));
        if (seen.has(key)) return true;
        seen.add(key);
        return false;
      };
      while (queue.length > 0) {
        const task = queue.pop();
        if (visited(task)) continue;
        if (task.node) {
          handle(climb(task.node, task.derived, task.holder, helpers), task.node, task);
          continue;
        }
        for (const reference of task.variable.references) {
          if (!reference.isRead()) continue;
          handle(climb(reference.identifier, task.derived, task.holder, helpers), reference.identifier, task);
        }
      }

      function enqueueVariable(variable, derived, holder, returnTo) {
        if (variable) queue.push({ variable, derived, holder, returnTo });
      }

      function variableOf(identifier) {
        return findVariable(sourceCode.getScope(identifier), identifier.name);
      }

      function handle(end, from, task) {
        if (!end) return;
        const { returnTo } = task;
        if (end.log) {
          if (reported.has(from)) return;
          reported.add(from);
          context.report({ node: from, messageId: "raw", data: { name } });
        } else if (end.declare) {
          const { id } = end.declare;
          const names = end.holder ? holderNames(id, end.holder, []) : boundNames(id, end.derived, []);
          for (const declared of sourceCode.getDeclaredVariables(end.declare)) {
            if (!names.includes(declared.name)) continue;
            if (id.type === "Identifier") enqueueVariable(declared, end.derived, end.holder, returnTo);
            // const { error } = { error: e }: error is the error itself.
            else if (end.holder && end.holder !== ANY_KEY) enqueueVariable(declared, end.derived, false, returnTo);
            else enqueueVariable(declared, true, end.holder ? ANY_KEY : false, returnTo);
          }
        } else if (end.assign) {
          enqueueVariable(variableOf(end.assign), end.derived, end.holder, returnTo);
        } else if (end.stored) {
          enqueueVariable(variableOf(end.stored), task.derived, ANY_KEY, returnTo);
        } else if (end.holds) {
          queue.push({ node: end.holds, derived: task.derived, holder: ANY_KEY, returnTo });
          if (end.target) enqueueVariable(variableOf(end.target), task.derived, ANY_KEY, returnTo);
        } else if (end.enter) {
          let depth = 0;
          for (let r = returnTo; r; r = r.outer) depth += 1;
          if (depth >= MAX_HELPER_DEPTH) return;
          const entered = { call: end.call, outer: returnTo };
          for (const param of helpers.paramVariables(end.enter, end.index)) {
            enqueueVariable(param.variable, end.derived || param.derived, param.derived ? false : end.holder, entered);
          }
        } else if (end.returns) {
          const fn = end.returns;
          const out = { derived: end.derived, holder: end.holder };
          // Back out of the helper we entered, at the call that entered it.
          if (returnTo && helpers.localFunction(returnTo.call.callee) === fn) {
            queue.push({ node: returnTo.call, ...out, returnTo: returnTo.outer });
            return;
          }
          // A .catch or .then handler: the promise chain's result.
          const call = fn.parent;
          if (call?.type === "CallExpression" && call.arguments.includes(fn) && ["catch", "then"].includes(propertyName(call.callee))) {
            queue.push({ node: call, ...out, returnTo });
            return;
          }
          // A local function returning it: every call of it.
          for (const reference of helpers.functionVariable(fn)?.references ?? []) {
            const parent = reference.identifier.parent;
            if (parent.type === "CallExpression" && parent.callee === reference.identifier) {
              queue.push({ node: parent, ...out, returnTo: null });
            }
          }
        }
      }
    }

    function trackParam(fn) {
      if (!isFunction(fn) || fn.params.length === 0) return;
      track(
        helpers.paramVariables(fn, 0).map(({ variable, derived }) => ({ variable, derived })),
        paramLabel(fn.params[0]),
      );
    }

    return {
      CatchClause(node) {
        if (!node.param) return;
        const derived = node.param.type !== "Identifier";
        track(
          sourceCode.getDeclaredVariables(node).map((variable) => ({ variable, derived })),
          node.param.type === "Identifier" ? node.param.name : "error",
        );
      },
      CallExpression(node) {
        const method = propertyName(node.callee);
        if (method === "catch") trackParam(node.arguments[0]);
        else if (method === "then") trackParam(node.arguments[1]);
        else if (method && LISTENER_METHODS.has(method)) {
          const [event, listener] = node.arguments;
          if (event?.type === "Literal" && ERROR_EVENTS.has(event.value)) trackParam(listener);
        }
      },
      Property(node) {
        if (isCallbackKey(node)) trackParam(node.value);
      },
      JSXAttribute(node) {
        if (node.name.type !== "JSXIdentifier" || !CALLBACK_KEYS.has(node.name.name)) return;
        const fn = node.value?.type === "JSXExpressionContainer" ? node.value.expression : null;
        trackParam(fn);
      },
    };
  },
};

export default rule;
