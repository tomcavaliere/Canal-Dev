// Mise en forme du texte des messages, construite nœud par nœud (jamais d'innerHTML) :
//   ```bloc de code```  →  <pre><code>
//   `code`              →  <code>
//   http(s)://…         →  lien ouvert dans un nouvel onglet, sans référent
// Tout le reste est du texte brut.

const FENCE_RE = /```(?:[^\n`]*\n)?([\s\S]*?)```/g; // la 1re ligne peut nommer un langage (ignoré)
const INLINE_RE = /`([^`\n]+)`|\bhttps?:\/\/[^\s<>"'`]+/gi;

/**
 * @param {string} text
 * @returns {DocumentFragment}
 */
export function renderRichText(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(FENCE_RE)) {
    appendInline(frag, text.slice(last, m.index));
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = m[1].replace(/\n$/, "");
    pre.append(code);
    frag.append(pre);
    last = m.index + m[0].length;
  }
  appendInline(frag, text.slice(last));
  return frag;
}

function appendInline(parent, text) {
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    let token = m[0];
    let node;
    if (m[1] !== undefined) {
      node = document.createElement("code");
      node.textContent = m[1];
    } else {
      token = trimUrl(token);
      node = link(token);
    }
    parent.append(text.slice(last, m.index));
    parent.append(node || token);
    last = m.index + token.length;
  }
  parent.append(text.slice(last));
}

// Ponctuation finale qui appartient à la phrase, pas à l'adresse : « voir https://x.fr. »
// Une parenthèse fermante n'est gardée que si l'adresse en ouvre une (liens Wikipédia).
function trimUrl(url) {
  for (;;) {
    const c = url.at(-1);
    if (".,;:!?'\"»".includes(c)) url = url.slice(0, -1);
    else if (c === ")" && count(url, "(") < count(url, ")")) url = url.slice(0, -1);
    else if (c === "]" && count(url, "[") < count(url, "]")) url = url.slice(0, -1);
    else return url;
  }
}

function count(s, ch) {
  return s.split(ch).length - 1;
}

function link(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const a = document.createElement("a");
  a.href = url.href;
  a.textContent = raw;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}
