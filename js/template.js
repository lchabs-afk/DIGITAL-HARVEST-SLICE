// Bambu Studio G-code template interpreter.
// Supports the subset of the PrusaSlicer/Bambu placeholder language used by the
// official Bambu Lab machine profiles:
//   [var]                       legacy placeholder (first element of an array)
//   {expr}                      expression output
//   {if expr} … {elsif expr} … {else} … {endif}
// Expressions: numbers, "strings", true/false, variables, var[index],
// + - * / %, comparisons, && || !, ?: , parentheses, and the functions
// min max ceil floor round int abs.
(function (DH) {
  "use strict";

  class TemplateError extends Error {}

  function fmt(v) {
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") {
      if (!isFinite(v)) throw new TemplateError("Result is not a finite number");
      if (Number.isInteger(v)) return String(v);
      return String(Number(v.toFixed(5)));
    }
    if (Array.isArray(v)) return v.map(fmt).join(",");
    return String(v);
  }

  // ---------- expression tokenizer / parser ----------
  function tokenize(src) {
    const toks = [];
    let i = 0;
    while (i < src.length) {
      const c = src[i];
      if (/\s/.test(c)) { i++; continue; }
      if (/[0-9.]/.test(c)) {
        const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
        toks.push({ t: "num", v: parseFloat(m[0]) }); i += m[0].length; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
        toks.push({ t: "id", v: m[0] }); i += m[0].length; continue;
      }
      if (c === '"') {
        let j = i + 1, s = "";
        while (j < src.length && src[j] !== '"') { s += src[j]; j++; }
        toks.push({ t: "str", v: s }); i = j + 1; continue;
      }
      const two = src.slice(i, i + 2);
      if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) { toks.push({ t: "op", v: two }); i += 2; continue; }
      if ("+-*/%<>!()[],?:".includes(c)) { toks.push({ t: "op", v: c }); i++; continue; }
      throw new TemplateError("Unexpected character '" + c + "' in {" + src + "}");
    }
    return toks;
  }

  const FUNCS = {
    min: Math.min, max: Math.max, ceil: Math.ceil, floor: Math.floor,
    round: Math.round, int: Math.trunc, abs: Math.abs,
  };

  function evaluate(src, vars) {
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p];
    const isOp = (v) => toks[p] && toks[p].t === "op" && toks[p].v === v;
    const expect = (v) => { if (!isOp(v)) throw new TemplateError("Expected '" + v + "' in {" + src + "}"); p++; };

    function primary() {
      const tk = toks[p++];
      if (!tk) throw new TemplateError("Unexpected end of {" + src + "}");
      if (tk.t === "num" || tk.t === "str") return tk.v;
      if (tk.t === "op" && tk.v === "(") { const v = ternary(); expect(")"); return v; }
      if (tk.t === "op" && tk.v === "-") return -unary();
      if (tk.t === "op" && tk.v === "+") return +unary();
      if (tk.t === "op" && tk.v === "!") return !truthy(unary());
      if (tk.t === "id") {
        if (tk.v === "true") return true;
        if (tk.v === "false") return false;
        if (isOp("(") && FUNCS[tk.v]) {
          p++;
          const args = [];
          if (!isOp(")")) { args.push(ternary()); while (isOp(",")) { p++; args.push(ternary()); } }
          expect(")");
          return FUNCS[tk.v].apply(null, args.map(Number));
        }
        if (!(tk.v in vars)) throw new TemplateError("Unknown variable '" + tk.v + "'");
        let v = vars[tk.v];
        if (isOp("[")) {
          p++; const idx = ternary(); expect("]");
          if (!Array.isArray(v)) v = [v];
          v = v[Math.max(0, Math.min(v.length - 1, Math.trunc(idx)))];
        }
        return v;
      }
      throw new TemplateError("Unexpected token in {" + src + "}");
    }
    function unary() { return primary(); }
    function mul() {
      let v = unary();
      while (isOp("*") || isOp("/") || isOp("%")) {
        const o = toks[p++].v, r = unary();
        v = o === "*" ? Number(v) * Number(r) : o === "/" ? Number(v) / Number(r) : Number(v) % Number(r);
      }
      return v;
    }
    function add() {
      let v = mul();
      while (isOp("+") || isOp("-")) {
        const o = toks[p++].v, r = mul();
        v = o === "+" ? (typeof v === "string" || typeof r === "string" ? String(v) + String(r) : Number(v) + Number(r)) : Number(v) - Number(r);
      }
      return v;
    }
    function cmp() {
      let v = add();
      while (["<", ">", "<=", ">=", "==", "!="].some(isOp)) {
        const o = toks[p++].v, r = add();
        if (o === "==") v = v == r; // eslint-disable-line eqeqeq
        else if (o === "!=") v = v != r; // eslint-disable-line eqeqeq
        else if (o === "<") v = Number(v) < Number(r);
        else if (o === ">") v = Number(v) > Number(r);
        else if (o === "<=") v = Number(v) <= Number(r);
        else v = Number(v) >= Number(r);
      }
      return v;
    }
    function and() { let v = cmp(); while (isOp("&&")) { p++; const r = cmp(); v = truthy(v) && truthy(r); } return v; }
    function or() { let v = and(); while (isOp("||")) { p++; const r = and(); v = truthy(v) || truthy(r); } return v; }
    function ternary() {
      const c = or();
      if (isOp("?")) { p++; const a = ternary(); expect(":"); const b = ternary(); return truthy(c) ? a : b; }
      return c;
    }
    const v = ternary();
    if (p < toks.length) throw new TemplateError("Unexpected '" + peek().v + "' in {" + src + "}");
    return v;
  }

  function truthy(v) { return Array.isArray(v) ? truthy(v[0]) : !!v; }

  // ---------- template structure ----------
  function parse(text) {
    // Returns a node list: strings, {expr}, {legacy}, {if:[[cond, nodes]...], else: nodes}
    const root = [];
    const stack = [{ nodes: root }];
    const re = /\{([^{}]*)\}|\[([A-Za-z_][A-Za-z0-9_]*)\]/g;
    let last = 0, m;
    const cur = () => stack[stack.length - 1].nodes;
    while ((m = re.exec(text))) {
      if (m.index > last) cur().push(text.slice(last, m.index));
      last = re.lastIndex;
      if (m[2] !== undefined) { cur().push({ legacy: m[2] }); continue; }
      const body = m[1].trim();
      let mm;
      if ((mm = /^if\b([\s\S]*)$/.exec(body))) {
        const node = { branches: [[mm[1].trim(), []]], elseNodes: null };
        cur().push(node);
        stack.push({ node, nodes: node.branches[0][1] });
      } else if ((mm = /^elsif\b([\s\S]*)$/.exec(body))) {
        const top = stack[stack.length - 1];
        if (!top.node) throw new TemplateError("{elsif} without {if}");
        const br = [mm[1].trim(), []];
        top.node.branches.push(br); top.nodes = br[1];
      } else if (body === "else") {
        const top = stack[stack.length - 1];
        if (!top.node) throw new TemplateError("{else} without {if}");
        top.node.elseNodes = []; top.nodes = top.node.elseNodes;
      } else if (body === "endif") {
        if (stack.length < 2) throw new TemplateError("{endif} without {if}");
        stack.pop();
      } else {
        cur().push({ expr: body });
      }
    }
    if (last < text.length) cur().push(text.slice(last));
    if (stack.length !== 1) throw new TemplateError("Missing {endif}");
    return root;
  }

  function run(nodes, vars, out) {
    for (const n of nodes) {
      if (typeof n === "string") out.push(n);
      else if (n.legacy !== undefined) {
        if (!(n.legacy in vars)) throw new TemplateError("Unknown variable '" + n.legacy + "'");
        const v = vars[n.legacy];
        out.push(fmt(Array.isArray(v) ? v[0] : v));
      } else if (n.expr !== undefined) out.push(fmt(evaluate(n.expr, vars)));
      else {
        let done = false;
        for (const [cond, body] of n.branches) {
          if (truthy(evaluate(cond, vars))) { run(body, vars, out); done = true; break; }
        }
        if (!done && n.elseNodes) run(n.elseNodes, vars, out);
      }
    }
  }

  function render(text, vars) {
    const out = [];
    run(parse(text || ""), vars, out);
    return out.join("");
  }

  DH.template = { render, evaluate, TemplateError };
})(globalThis.DH = globalThis.DH || {});
