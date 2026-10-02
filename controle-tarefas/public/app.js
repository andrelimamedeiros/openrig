// Controle de Tarefas — interface (JavaScript puro, sem bibliotecas).

const $ = (sel, raiz = document) => raiz.querySelector(sel);
const $$ = (sel, raiz = document) => [...raiz.querySelectorAll(sel)];

let E = { versao: -1, clientes: [], projetos: [], pessoas: [], tarefas: [], apontamentos: [] };
let M = {}; // índices por id, recalculados a cada carga

const STATUS_PROJETO = { ativo: "Ativo", pausado: "Pausado", concluido: "Concluído" };
const PRIORIDADES = { baixa: "Baixa", normal: "Normal", alta: "Alta" };
const STATUS_TAREFA = { a_fazer: "A fazer", em_andamento: "Em andamento", concluida: "Concluída" };
const NOVO = "__novo";

// ---------- preferências locais (por computador) ----------
function lerPref(chave, padrao) {
  try {
    const v = localStorage.getItem(`ct.${chave}`);
    return v === null ? padrao : JSON.parse(v);
  } catch {
    return padrao;
  }
}
function gravarPref(chave, valor) {
  try {
    localStorage.setItem(`ct.${chave}`, JSON.stringify(valor));
  } catch {
    /* navegador sem armazenamento local: segue sem lembrar */
  }
}
let eu = lerPref("eu", "");
let abaAtual = lerPref("aba", "tarefas");
let periodo = { tipo: "semana", de: "", ate: "" };

// ---------- utilitários ----------
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function corPorTexto(texto) {
  let h = 0;
  for (const c of String(texto)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `hsl(${h} 62% 48%)`;
}

const corPessoa = (p) => p?.cor || corPorTexto(p?.id ?? "");
const corProjeto = (p) => (p ? corPorTexto(p.id) : "");

function iniciais(nome) {
  const partes = String(nome).trim().split(/\s+/);
  return ((partes[0]?.[0] ?? "") + (partes.length > 1 ? partes.at(-1)[0] : "")).toUpperCase();
}

function avatar(p) {
  if (!p) return "";
  return `<span class="avatar" style="background:${esc(corPessoa(p))}" title="${esc(p.nome)}">${esc(iniciais(p.nome))}</span>`;
}

function fmtHoras(ms) {
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

function relogio(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

const hojeIso = () => dataLocal(new Date());
function dataLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function horaLocal(d) {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function fmtData(iso) {
  if (!iso) return "";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${a}`;
}

const duracao = (a) => (a.fim ? Date.parse(a.fim) : Date.now()) - Date.parse(a.inicio);

function aviso(texto, erro = false) {
  const el = document.createElement("div");
  el.className = `aviso${erro ? " erro" : ""}`;
  el.textContent = texto;
  $("#avisos").append(el);
  setTimeout(() => el.remove(), erro ? 5000 : 2500);
}

async function api(metodo, url, corpo) {
  const res = await fetch(url, {
    method: metodo,
    headers: corpo ? { "content-type": "application/json" } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  if (res.status === 204) return null;
  const dados = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(dados.erro || `Erro ${res.status}`);
  return dados;
}

async function acao(fn, mensagem) {
  try {
    const r = await fn();
    if (mensagem) aviso(mensagem);
    await carregar();
    return r;
  } catch (e) {
    aviso(e.message, true);
    return null;
  }
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
  } catch {
    // Em http:// na rede interna o navegador bloqueia a API moderna; usa o método antigo.
    const t = document.createElement("textarea");
    t.value = texto;
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  aviso("Caminho copiado — cole no Explorador de Arquivos");
}

// ---------- carga e sincronização ----------
async function carregar() {
  const novo = await api("GET", "/api/estado");
  E = novo;
  M = {};
  for (const col of ["clientes", "projetos", "pessoas", "tarefas"]) M[col] = new Map(E[col].map((x) => [x.id, x]));
  if (eu && !M.pessoas.has(eu)) eu = "";
  render();
}

function conectarEventos() {
  const fonte = new EventSource("/api/eventos");
  fonte.onmessage = (ev) => {
    if (Number(ev.data) !== E.versao) carregar().catch(() => {});
  };
  fonte.onerror = () => {
    fonte.close();
    setTimeout(conectarEventos, 3000);
  };
}

// ---------- dados derivados ----------
const rodandoDe = (pessoaId) => E.apontamentos.find((a) => a.pessoaId === pessoaId && !a.fim);
const apontamentosDaTarefa = (id) => E.apontamentos.filter((a) => a.tarefaId === id);
const nomeProjeto = (p) => (p ? (p.codigo ? `${p.codigo} · ${p.nome}` : p.nome) : "");

function tempoDaTarefa(id) {
  let base = 0;
  const desde = [];
  for (const a of apontamentosDaTarefa(id)) {
    if (a.fim) base += duracao(a);
    else desde.push(Date.parse(a.inicio));
  }
  return { base, desde };
}

function horasDoProjeto(projetoId) {
  const tarefas = new Set(E.tarefas.filter((t) => t.projetoId === projetoId).map((t) => t.id));
  return E.apontamentos.filter((a) => tarefas.has(a.tarefaId)).reduce((s, a) => s + duracao(a), 0);
}

// Quem cronometra quando a pessoa clica em "Iniciar": quem está no "Eu sou", senão o responsável.
function quemExecuta(tarefa) {
  return eu || tarefa.responsavelId || "";
}

// ---------- selects ----------
function preencherSelect(el, opcoes, { vazio, novo } = {}) {
  const atual = el.value;
  el.innerHTML =
    (vazio !== undefined ? `<option value="">${esc(vazio)}</option>` : "") +
    opcoes.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("") +
    (novo ? `<option value="${NOVO}">${esc(novo)}</option>` : "");
  if ([...el.options].some((o) => o.value === atual)) el.value = atual;
}

const opcoesPessoas = () => [...E.pessoas].sort((a, b) => a.nome.localeCompare(b.nome)).map((p) => [p.id, p.nome]);
const opcoesClientes = () => [...E.clientes].sort((a, b) => a.nome.localeCompare(b.nome)).map((c) => [c.id, c.nome]);
function opcoesProjetos(incluirId) {
  return [...E.projetos]
    .filter((p) => p.status !== "concluido" || p.id === incluirId)
    .sort((a, b) => nomeProjeto(a).localeCompare(nomeProjeto(b)))
    .map((p) => {
      const c = M.clientes.get(p.clienteId);
      return [p.id, c ? `${nomeProjeto(p)} (${c.nome})` : nomeProjeto(p)];
    });
}
const opcoesTarefas = () =>
  [...E.tarefas]
    .sort((a, b) => a.titulo.localeCompare(b.titulo))
    .map((t) => {
      const p = M.projetos.get(t.projetoId);
      return [t.id, p ? `${t.titulo} — ${nomeProjeto(p)}` : t.titulo];
    });

// Ao escolher "+ Novo…" num select, abre o cadastro rápido e já seleciona o item criado.
function ligarNovo(el, colecao, aoMudar) {
  el.addEventListener("change", async () => {
    if (el.value !== NOVO) return aoMudar?.();
    const anterior = el.dataset.anterior ?? "";
    const criado = await abrirFormulario(colecao);
    render();
    el.value = criado ? criado.id : anterior;
    aoMudar?.();
  });
  el.addEventListener("focus", () => (el.dataset.anterior = el.value));
}

function renderSelects() {
  preencherSelect($("#eu-sou"), opcoesPessoas(), { vazio: "— escolha —", novo: "+ Cadastrar pessoa…" });
  $("#eu-sou").value = eu;
  preencherSelect($("#rapida-projeto"), opcoesProjetos(), { vazio: "Sem projeto", novo: "+ Novo projeto…" });
  const resp = $("#rapida-responsavel");
  preencherSelect(resp, opcoesPessoas(), { vazio: "Sem responsável", novo: "+ Nova pessoa…" });
  if (!resp.dataset.tocado) resp.value = eu;
  preencherSelect($("#f-projeto"), opcoesProjetos(), { vazio: "Todos os projetos" });
  const fr = $("#f-responsavel");
  preencherSelect(fr, [["__eu", "Minhas tarefas"], ["__sem", "Sem responsável"], ...opcoesPessoas()], { vazio: "Todos os responsáveis" });
  preencherSelect($("#h-pessoa"), opcoesPessoas(), { vazio: "Todas as pessoas" });
}

// ---------- topo: meu cronômetro ----------
function renderMeuTimer() {
  const el = $("#meu-timer");
  const a = eu && rodandoDe(eu);
  if (!a) {
    el.hidden = true;
    return;
  }
  const t = M.tarefas.get(a.tarefaId);
  el.hidden = false;
  el.innerHTML = `<span data-desde="${Date.parse(a.inicio)}" data-base="0">${relogio(duracao(a))}</span>
    <span class="nome" title="${esc(t?.titulo)}">${esc(t?.titulo ?? "")}</span>
    <button class="play parar" data-parar="${esc(a.tarefaId)}">■ Parar</button>`;
}

// ---------- aba Tarefas ----------
function filtrarTarefas() {
  const busca = $("#f-busca").value.trim().toLowerCase();
  const proj = $("#f-projeto").value;
  let resp = $("#f-responsavel").value;
  if (resp === "__eu") resp = eu || "__ninguem";
  return E.tarefas.filter((t) => {
    if (proj && t.projetoId !== proj) return false;
    if (resp === "__sem" && t.responsavelId) return false;
    if (resp && resp !== "__sem" && t.responsavelId !== resp) return false;
    if (busca) {
      const p = M.projetos.get(t.projetoId);
      const c = M.clientes.get(p?.clienteId);
      const texto = [t.titulo, t.descricao, p?.nome, p?.codigo, c?.nome, M.pessoas.get(t.responsavelId)?.nome].join(" ").toLowerCase();
      if (!texto.includes(busca)) return false;
    }
    return true;
  });
}

function ordenar(tarefas, status) {
  const peso = { alta: 0, normal: 1, baixa: 2 };
  return tarefas.sort((a, b) => {
    if (status === "concluida") return (b.atualizadoEm ?? b.criadoEm).localeCompare(a.atualizadoEm ?? a.criadoEm);
    return (
      (peso[a.prioridade] ?? 1) - (peso[b.prioridade] ?? 1) ||
      (a.prazo || "9999").localeCompare(b.prazo || "9999") ||
      a.criadoEm.localeCompare(b.criadoEm)
    );
  });
}

function cartao(t) {
  const p = M.projetos.get(t.projetoId);
  const c = M.clientes.get(p?.clienteId);
  const r = M.pessoas.get(t.responsavelId);
  const { base, desde } = tempoDaTarefa(t.id);
  const rodando = E.apontamentos.filter((a) => a.tarefaId === t.id && !a.fim);
  const quem = quemExecuta(t);
  const euRodando = rodando.some((a) => a.pessoaId === quem);
  const outros = rodando.filter((a) => a.pessoaId !== quem).map((a) => M.pessoas.get(a.pessoaId)?.nome).filter(Boolean);
  const hoje = hojeIso();
  let prazo = "";
  if (t.prazo) {
    const classe = t.status !== "concluida" && t.prazo < hoje ? "atrasada" : t.status !== "concluida" && t.prazo === hoje ? "hoje" : "";
    prazo = `<span class="${classe}">📅 ${t.prazo === hoje ? "Hoje" : fmtData(t.prazo)}</span>`;
  }
  const total = base + desde.reduce((s, d) => s + (Date.now() - d), 0);
  const concluida = t.status === "concluida";
  return `<div class="cartao${rodando.length ? " rodando" : ""}${concluida ? " concluida" : ""}" draggable="true" data-id="${esc(t.id)}" style="--cor-projeto:${esc(corProjeto(p))}">
    <div class="titulo" data-editar="${esc(t.id)}">${esc(t.titulo)}</div>
    <div class="meta">
      ${p ? `<span>📁 ${esc(nomeProjeto(p))}${c ? ` · ${esc(c.nome)}` : ""}</span>` : ""}
      ${prazo}
      ${t.prioridade === "alta" ? `<span class="prioridade-alta">▲ Alta</span>` : ""}
      ${outros.length ? `<span>⏱ ${esc(outros.join(", "))} trabalhando</span>` : ""}
    </div>
    <div class="rodape">
      <span class="tempo" data-base="${base}" data-desde="${desde.join(",")}">${total ? (desde.length ? relogio(total) : fmtHoras(total)) : "0m"}</span>
      ${r ? `<span class="pessoa-tag">${avatar(r)}</span>` : `<span class="sub" title="Sem responsável">—</span>`}
      ${
        concluida
          ? `<button class="icone" data-status="${esc(t.id)}:a_fazer" title="Reabrir">↺</button>`
          : `${euRodando ? `<button class="play parar" data-parar="${esc(t.id)}">■ Parar</button>` : `<button class="play" data-iniciar="${esc(t.id)}">▶ Iniciar</button>`}
             <button class="icone" data-status="${esc(t.id)}:concluida" title="Concluir">✓</button>`
      }
    </div>
  </div>`;
}

function renderTarefas() {
  const mostrarConcluidas = $("#f-concluidas").checked;
  $("#quadro").classList.toggle("sem-concluidas", !mostrarConcluidas);
  const lista = filtrarTarefas();
  for (const col of $$("#quadro .coluna")) {
    const status = col.dataset.status;
    const doStatus = ordenar(lista.filter((t) => t.status === status), status);
    const visiveis = status === "concluida" ? doStatus.slice(0, 60) : doStatus;
    $(".qtd", col).textContent = `(${doStatus.length})`;
    $(".cartoes", col).innerHTML = visiveis.length
      ? visiveis.map(cartao).join("")
      : `<div class="vazio">${status === "a_fazer" && !E.tarefas.length ? "Digite uma tarefa acima e tecle Enter para começar." : "Nada por aqui."}</div>`;
  }
}

async function iniciar(tarefaId) {
  const t = M.tarefas.get(tarefaId);
  const pessoaId = quemExecuta(t);
  if (!pessoaId) {
    aviso('Escolha seu nome em "Eu sou" (no topo) para cronometrar.', true);
    $("#eu-sou").focus();
    return;
  }
  const anterior = rodandoDe(pessoaId);
  await acao(() => api("POST", `/api/tarefas/${tarefaId}/iniciar`, { pessoaId }), anterior ? "Cronômetro trocado de tarefa" : "Cronômetro iniciado");
}

async function parar(tarefaId) {
  const t = M.tarefas.get(tarefaId);
  await acao(() => api("POST", `/api/tarefas/${tarefaId}/parar`, { pessoaId: quemExecuta(t) || undefined }), "Cronômetro parado");
}

async function mudarStatus(tarefaId, status) {
  await acao(() => api("PUT", `/api/tarefas/${tarefaId}`, { status }), status === "concluida" ? "Tarefa concluída ✓" : null);
}

// ---------- aba Projetos ----------
function renderProjetos() {
  const busca = $("#busca-projetos").value.trim().toLowerCase();
  const ordem = { ativo: 0, pausado: 1, concluido: 2 };
  const lista = E.projetos
    .filter((p) => {
      const c = M.clientes.get(p.clienteId);
      return !busca || [p.nome, p.codigo, p.pasta, c?.nome].join(" ").toLowerCase().includes(busca);
    })
    .sort((a, b) => (ordem[a.status] ?? 0) - (ordem[b.status] ?? 0) || nomeProjeto(a).localeCompare(nomeProjeto(b)));
  $("#lista-projetos").innerHTML = lista.length
    ? lista
        .map((p) => {
          const c = M.clientes.get(p.clienteId);
          const abertas = E.tarefas.filter((t) => t.projetoId === p.id && t.status !== "concluida").length;
          return `<div class="ficha${p.status === "concluido" ? " arquivado" : ""}" style="border-left:4px solid ${esc(corProjeto(p))}">
            <h3>${p.codigo ? `<span class="sub">${esc(p.codigo)}</span>` : ""}${esc(p.nome)} <span class="selo ${p.status === "ativo" ? "ativo" : ""}">${esc(STATUS_PROJETO[p.status] ?? p.status)}</span></h3>
            <div class="linha"><span class="rotulo">Cliente:</span> ${c ? esc(c.nome) : "—"}</div>
            ${p.prazo ? `<div class="linha"><span class="rotulo">Prazo:</span> ${fmtData(p.prazo)}</div>` : ""}
            ${
              p.pasta
                ? `<div class="linha"><span class="rotulo">Pasta:</span><span class="pasta" title="${esc(p.pasta)}">${esc(p.pasta)}</span><button class="icone" data-copiar="${esc(p.pasta)}" title="Copiar caminho">📋</button></div>`
                : ""
            }
            <div class="numeros">
              <div><strong>${abertas}</strong><span>tarefas abertas</span></div>
              <div><strong>${fmtHoras(horasDoProjeto(p.id))}</strong><span>horas lançadas</span></div>
            </div>
            <div class="acoes">
              <button data-ver-projeto="${esc(p.id)}">Ver tarefas</button>
              <button data-nova-tarefa="${esc(p.id)}">+ Tarefa</button>
              <button data-editar-em="projetos:${esc(p.id)}">Editar</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="vazio">Nenhum projeto ainda. Clique em “+ Novo projeto”.</div>`;
}

// ---------- aba Clientes ----------
function renderClientes() {
  const busca = $("#busca-clientes").value.trim().toLowerCase();
  const lista = E.clientes
    .filter((c) => !busca || [c.nome, c.contato, c.email, c.telefone, c.documento].join(" ").toLowerCase().includes(busca))
    .sort((a, b) => a.nome.localeCompare(b.nome));
  $("#lista-clientes").innerHTML = lista.length
    ? lista
        .map((c) => {
          const projetos = E.projetos.filter((p) => p.clienteId === c.id);
          const horas = projetos.reduce((s, p) => s + horasDoProjeto(p.id), 0);
          return `<div class="ficha">
            <h3>${esc(c.nome)}</h3>
            ${c.documento ? `<div class="sub">${esc(c.documento)}</div>` : ""}
            ${c.contato ? `<div class="linha"><span class="rotulo">Contato:</span> ${esc(c.contato)}</div>` : ""}
            ${c.telefone ? `<div class="linha"><span class="rotulo">Telefone:</span> <a href="tel:${esc(c.telefone)}">${esc(c.telefone)}</a></div>` : ""}
            ${c.email ? `<div class="linha"><span class="rotulo">E-mail:</span> <a href="mailto:${esc(c.email)}">${esc(c.email)}</a></div>` : ""}
            ${c.observacoes ? `<div class="sub">${esc(c.observacoes)}</div>` : ""}
            <div class="numeros">
              <div><strong>${projetos.filter((p) => p.status !== "concluido").length}</strong><span>projetos ativos</span></div>
              <div><strong>${fmtHoras(horas)}</strong><span>horas lançadas</span></div>
            </div>
            <div class="acoes">
              <button data-novo-projeto-cliente="${esc(c.id)}">+ Projeto</button>
              <button data-editar-em="clientes:${esc(c.id)}">Editar</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="vazio">Nenhum cliente ainda. Clique em “+ Novo cliente”.</div>`;
}

// ---------- aba Equipe ----------
function inicioDaSemana() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

function renderEquipe() {
  const hoje = new Date().setHours(0, 0, 0, 0);
  const semana = inicioDaSemana();
  const lista = [...E.pessoas].sort((a, b) => a.nome.localeCompare(b.nome));
  $("#lista-equipe").innerHTML = lista.length
    ? lista
        .map((p) => {
          const meus = E.apontamentos.filter((a) => a.pessoaId === p.id);
          const soma = (desde) => meus.filter((a) => Date.parse(a.inicio) >= desde).reduce((s, a) => s + duracao(a), 0);
          const rodando = rodandoDe(p.id);
          const t = rodando && M.tarefas.get(rodando.tarefaId);
          const abertas = E.tarefas.filter((x) => x.responsavelId === p.id && x.status !== "concluida").length;
          return `<div class="ficha">
            <h3>${avatar(p)} ${esc(p.nome)} ${p.id === eu ? `<span class="selo">você</span>` : ""}</h3>
            ${p.funcao ? `<div class="sub">${esc(p.funcao)}</div>` : ""}
            <div class="linha">${
              t
                ? `<span class="selo rodando">⏱ <span data-desde="${Date.parse(rodando.inicio)}" data-base="0">${relogio(duracao(rodando))}</span></span> ${esc(t.titulo)}`
                : `<span class="sub">Sem cronômetro ativo</span>`
            }</div>
            <div class="numeros">
              <div><strong>${abertas}</strong><span>tarefas abertas</span></div>
              <div><strong>${fmtHoras(soma(hoje))}</strong><span>hoje</span></div>
              <div><strong>${fmtHoras(soma(semana))}</strong><span>na semana</span></div>
            </div>
            <div class="acoes">
              <button data-ver-pessoa="${esc(p.id)}">Ver tarefas</button>
              <button data-editar-em="pessoas:${esc(p.id)}">Editar</button>
            </div>
          </div>`;
        })
        .join("")
    : `<div class="vazio">Cadastre as pessoas da equipe para atribuir tarefas e cronometrar horas.</div>`;
}

// ---------- aba Horas ----------
function aplicarPeriodo(tipo) {
  periodo.tipo = tipo;
  const hoje = new Date();
  if (tipo === "hoje") periodo.de = periodo.ate = dataLocal(hoje);
  if (tipo === "semana") {
    periodo.de = dataLocal(new Date(inicioDaSemana()));
    periodo.ate = dataLocal(hoje);
  }
  if (tipo === "mes") {
    periodo.de = dataLocal(new Date(hoje.getFullYear(), hoje.getMonth(), 1));
    periodo.ate = dataLocal(hoje);
  }
  $("#h-de").value = periodo.de;
  $("#h-ate").value = periodo.ate;
  $$("#periodo button").forEach((b) => b.classList.toggle("ativa", b.dataset.periodo === tipo));
}

function blocoBarras(titulo, mapa) {
  const itens = [...mapa.entries()].sort((a, b) => b[1] - a[1]);
  const max = itens[0]?.[1] || 1;
  return `<div class="ficha"><h3>${esc(titulo)}</h3>${
    itens.length
      ? itens
          .map(([nome, ms]) => `<div class="barra-item"><span>${esc(nome)}</span><strong>${fmtHoras(ms)}</strong><div class="barra"><i style="width:${(ms / max) * 100}%"></i></div></div>`)
          .join("")
      : `<div class="sub">Sem horas no período.</div>`
  }</div>`;
}

function renderHoras() {
  const de = periodo.de ? new Date(`${periodo.de}T00:00:00`).getTime() : -Infinity;
  const ate = periodo.ate ? new Date(`${periodo.ate}T23:59:59.999`).getTime() : Infinity;
  const pessoa = $("#h-pessoa").value;
  const lista = E.apontamentos
    .filter((a) => {
      const t = Date.parse(a.inicio);
      return t >= de && t <= ate && (!pessoa || a.pessoaId === pessoa);
    })
    .sort((a, b) => b.inicio.localeCompare(a.inicio));

  const porProjeto = new Map();
  const porCliente = new Map();
  const porPessoa = new Map();
  let total = 0;
  const somar = (mapa, chave, ms) => mapa.set(chave, (mapa.get(chave) ?? 0) + ms);
  for (const a of lista) {
    const ms = duracao(a);
    const t = M.tarefas.get(a.tarefaId);
    const p = M.projetos.get(t?.projetoId);
    const c = M.clientes.get(p?.clienteId);
    total += ms;
    somar(porProjeto, p ? nomeProjeto(p) : "Sem projeto", ms);
    somar(porCliente, c?.nome ?? "Sem cliente", ms);
    somar(porPessoa, M.pessoas.get(a.pessoaId)?.nome ?? "—", ms);
  }

  $("#resumo-horas").innerHTML = `
    <div class="ficha"><h3>Total no período</h3><div class="total-geral">${fmtHoras(total)}</div><div class="sub">${lista.length} apontamentos</div></div>
    ${blocoBarras("Por projeto", porProjeto)}
    ${blocoBarras("Por cliente", porCliente)}
    ${blocoBarras("Por pessoa", porPessoa)}`;

  $("#tabela-horas").innerHTML = lista.length
    ? `<div class="tabela-rolagem"><table>
        <thead><tr><th>Data</th><th>Pessoa</th><th>Cliente</th><th>Projeto</th><th>Tarefa</th><th>Início</th><th>Fim</th><th>Duração</th><th>Nota</th><th></th></tr></thead>
        <tbody>${lista
          .map((a) => {
            const t = M.tarefas.get(a.tarefaId);
            const p = M.projetos.get(t?.projetoId);
            const c = M.clientes.get(p?.clienteId);
            const i = new Date(a.inicio);
            return `<tr>
              <td>${i.toLocaleDateString("pt-BR")}</td>
              <td>${esc(M.pessoas.get(a.pessoaId)?.nome ?? "")}</td>
              <td>${esc(c?.nome ?? "")}</td>
              <td>${esc(nomeProjeto(p))}</td>
              <td>${esc(t?.titulo ?? "")}</td>
              <td>${horaLocal(i)}</td>
              <td>${a.fim ? horaLocal(new Date(a.fim)) : `<span class="selo rodando">rodando</span>`}</td>
              <td class="num">${fmtHoras(duracao(a))}</td>
              <td>${esc(a.nota ?? "")}</td>
              <td><button class="icone" data-editar-em="apontamentos:${esc(a.id)}" title="Editar">✎</button></td>
            </tr>`;
          })
          .join("")}</tbody></table></div>`
    : `<div class="vazio">Nenhuma hora registrada neste período. Use ▶ Iniciar nas tarefas ou “+ Lançar horas”.</div>`;

  const params = new URLSearchParams({ de: periodo.de, ate: periodo.ate });
  if (pessoa) params.set("pessoaId", pessoa);
  $("#exportar").href = `/api/relatorio.csv?${params}`;
}

// ---------- render geral ----------
function render() {
  renderSelects();
  renderMeuTimer();
  renderTarefas();
  renderProjetos();
  renderClientes();
  renderEquipe();
  renderHoras();
}

function mostrarAba(aba) {
  abaAtual = aba;
  gravarPref("aba", aba);
  $$("#abas button").forEach((b) => b.classList.toggle("ativa", b.dataset.aba === aba));
  $$(".aba").forEach((s) => (s.hidden = s.id !== `aba-${aba}`));
}

// Atualiza os relógios a cada segundo sem redesenhar a tela.
setInterval(() => {
  const agora = Date.now();
  for (const el of $$("[data-desde]")) {
    if (!el.dataset.desde) continue;
    const extra = el.dataset.desde.split(",").reduce((s, d) => s + (agora - Number(d)), 0);
    el.textContent = relogio(Number(el.dataset.base) + extra);
  }
}, 1000);

// ---------- formulários (modais) ----------
function camposDe(colecao, item) {
  const f = (k, rotulo, extra = {}) => ({ k, rotulo, ...extra });
  switch (colecao) {
    case "clientes":
      return [
        f("nome", "Nome / Razão social *", { largo: true, obrigatorio: true }),
        f("contato", "Pessoa de contato"),
        f("telefone", "Telefone", { tipo: "tel" }),
        f("email", "E-mail", { tipo: "email" }),
        f("documento", "CNPJ / CPF"),
        f("observacoes", "Observações", { tipo: "textarea", largo: true }),
      ];
    case "projetos":
      return [
        f("nome", "Nome do projeto *", { largo: true, obrigatorio: true }),
        f("codigo", "Código", { dica: "Ex.: 2026-014" }),
        f("clienteId", "Cliente", { tipo: "select", opcoes: opcoesClientes(), vazio: "Sem cliente", novo: ["clientes", "+ Novo cliente…"] }),
        f("pasta", "Pasta no servidor", { largo: true, dica: "Ex.: \\\\servidor\\Projetos\\2026-014 ou P:\\Projetos\\2026-014" }),
        f("status", "Situação", { tipo: "select", opcoes: Object.entries(STATUS_PROJETO) }),
        f("prazo", "Prazo de entrega", { tipo: "date" }),
        f("observacoes", "Observações", { tipo: "textarea", largo: true }),
      ];
    case "pessoas":
      return [
        f("nome", "Nome *", { largo: true, obrigatorio: true }),
        f("funcao", "Função / cargo"),
        f("email", "E-mail", { tipo: "email" }),
        f("cor", "Cor", { tipo: "color" }),
      ];
    case "tarefas":
      return [
        f("titulo", "Tarefa *", { largo: true, obrigatorio: true }),
        f("projetoId", "Projeto", { tipo: "select", opcoes: opcoesProjetos(item?.projetoId), vazio: "Sem projeto", novo: ["projetos", "+ Novo projeto…"] }),
        f("responsavelId", "Responsável", { tipo: "select", opcoes: opcoesPessoas(), vazio: "Sem responsável", novo: ["pessoas", "+ Nova pessoa…"] }),
        f("prioridade", "Prioridade", { tipo: "select", opcoes: Object.entries(PRIORIDADES) }),
        f("prazo", "Prazo", { tipo: "date" }),
        f("status", "Situação", { tipo: "select", opcoes: Object.entries(STATUS_TAREFA) }),
        f("descricao", "Detalhes", { tipo: "textarea", largo: true }),
      ];
    case "apontamentos":
      return [
        f("tarefaId", "Tarefa *", { tipo: "select", opcoes: opcoesTarefas(), largo: true, obrigatorio: true }),
        f("pessoaId", "Pessoa *", { tipo: "select", opcoes: opcoesPessoas(), obrigatorio: true }),
        f("data", "Data *", { tipo: "date", obrigatorio: true }),
        f("horaInicio", "Início *", { tipo: "time", obrigatorio: true }),
        f("horaFim", "Fim", { tipo: "time", dica: "Vazio = ainda rodando" }),
        f("nota", "Nota", { largo: true }),
      ];
  }
  return [];
}

const TITULOS = {
  clientes: ["Novo cliente", "Editar cliente"],
  projetos: ["Novo projeto", "Editar projeto"],
  pessoas: ["Nova pessoa", "Editar pessoa"],
  tarefas: ["Nova tarefa", "Editar tarefa"],
  apontamentos: ["Lançar horas", "Editar horas"],
};

function valoresIniciais(colecao, item, preset) {
  if (colecao === "apontamentos") {
    const i = item ? new Date(item.inicio) : null;
    return {
      tarefaId: item?.tarefaId ?? preset.tarefaId ?? "",
      pessoaId: item?.pessoaId ?? preset.pessoaId ?? eu,
      data: i ? dataLocal(i) : hojeIso(),
      horaInicio: i ? horaLocal(i) : "",
      horaFim: item?.fim ? horaLocal(new Date(item.fim)) : "",
      nota: item?.nota ?? "",
    };
  }
  const padrao = {
    projetos: { status: "ativo" },
    tarefas: { status: "a_fazer", prioridade: "normal", responsavelId: eu },
    pessoas: { cor: "#2563eb" },
  }[colecao];
  return { ...padrao, ...preset, ...item };
}

function htmlCampo(c, valor) {
  const id = `c-${c.k}-${Math.random().toString(36).slice(2, 8)}`;
  let entrada;
  if (c.tipo === "textarea") entrada = `<textarea id="${id}" name="${c.k}">${esc(valor)}</textarea>`;
  else if (c.tipo === "select") {
    entrada = `<select id="${id}" name="${c.k}" ${c.obrigatorio ? "required" : ""}>
      ${c.vazio !== undefined ? `<option value="">${esc(c.vazio)}</option>` : c.obrigatorio ? `<option value="">— escolha —</option>` : ""}
      ${c.opcoes.map(([v, t]) => `<option value="${esc(v)}" ${v === valor ? "selected" : ""}>${esc(t)}</option>`).join("")}
      ${c.novo ? `<option value="${NOVO}">${esc(c.novo[1])}</option>` : ""}
    </select>`;
  } else {
    entrada = `<input id="${id}" name="${c.k}" type="${c.tipo ?? "text"}" value="${esc(valor)}" ${c.obrigatorio ? "required" : ""} ${c.dica ? `placeholder="${esc(c.dica)}"` : ""}>`;
  }
  return `<label class="campo${c.largo ? " largo" : ""}" for="${id}"><span>${esc(c.rotulo)}</span>${entrada}</label>`;
}

function historicoTarefa(tarefa) {
  const lista = apontamentosDaTarefa(tarefa.id).sort((a, b) => b.inicio.localeCompare(a.inicio));
  const total = lista.reduce((s, a) => s + duracao(a), 0);
  return `<div class="historico">
    <h3><span>Horas registradas: ${fmtHoras(total)}</span><button type="button" data-lancar>+ Lançar horas</button></h3>
    ${
      lista.length
        ? `<ul>${lista
            .map((a) => {
              const i = new Date(a.inicio);
              return `<li>${avatar(M.pessoas.get(a.pessoaId))} ${i.toLocaleDateString("pt-BR")} ${horaLocal(i)}–${a.fim ? horaLocal(new Date(a.fim)) : "agora"}
                ${a.nota ? `<span class="sub">${esc(a.nota)}</span>` : ""}
                <span class="dur">${fmtHoras(duracao(a))}</span>
                <button type="button" class="icone" data-editar-apont="${esc(a.id)}" title="Editar">✎</button></li>`;
            })
            .join("")}</ul>`
        : `<div class="sub">Nenhum registro ainda. Use ▶ Iniciar no cartão da tarefa.</div>`
    }
  </div>`;
}

// Abre um formulário em modal. Resolve com o registro salvo, ou null se cancelado.
function abrirFormulario(colecao, item = null, preset = {}) {
  return new Promise((resolver) => {
    const campos = camposDe(colecao, item);
    const valores = valoresIniciais(colecao, item, preset);
    const fundo = document.createElement("div");
    fundo.className = "fundo-modal";
    fundo.innerHTML = `<form class="modal" novalidate>
      <h2>${TITULOS[colecao][item ? 1 : 0]}</h2>
      <div class="campos">${campos.map((c) => htmlCampo(c, valores[c.k] ?? "")).join("")}</div>
      ${colecao === "tarefas" && item ? historicoTarefa(item) : ""}
      <div class="botoes-modal">
        ${item ? `<button type="button" class="perigo" data-excluir>Excluir</button>` : ""}
        <button type="button" data-cancelar>Cancelar</button>
        <button type="submit" class="primario">${item ? "Salvar" : "Cadastrar"}</button>
      </div>
    </form>`;
    document.body.append(fundo);
    const form = $("form", fundo);
    let fechado = false;

    const fechar = (resultado) => {
      if (fechado) return;
      fechado = true;
      fundo.remove();
      document.removeEventListener("keydown", aoTeclar);
      resolver(resultado);
    };
    const aoTeclar = (ev) => {
      if (ev.key === "Escape" && $$(".fundo-modal").at(-1) === fundo) fechar(null);
    };
    document.addEventListener("keydown", aoTeclar);

    for (const c of campos.filter((c) => c.novo)) {
      const sel = form.elements[c.k];
      sel.addEventListener("focus", () => (sel.dataset.anterior = sel.value));
      sel.addEventListener("change", async () => {
        if (sel.value !== NOVO) return;
        const criado = await abrirFormulario(c.novo[0]);
        if (criado) {
          const opt = new Option(criado.nome, criado.id, true, true);
          sel.insertBefore(opt, sel.querySelector(`option[value="${NOVO}"]`));
        } else sel.value = sel.dataset.anterior ?? "";
      });
    }

    $("[data-cancelar]", fundo).onclick = () => fechar(null);
    fundo.addEventListener("mousedown", (ev) => {
      if (ev.target === fundo) fechar(null);
    });

    $("[data-excluir]", fundo)?.addEventListener("click", async () => {
      const extra = colecao === "tarefas" && apontamentosDaTarefa(item.id).length ? " As horas registradas nela também serão apagadas." : "";
      if (!confirm(`Excluir este registro?${extra}`)) return;
      const ok = await acao(() => api("DELETE", `/api/${colecao}/${item.id}`).then(() => true), "Excluído");
      if (ok) fechar(null);
    });

    $("[data-lancar]", fundo)?.addEventListener("click", async () => {
      fechar(null);
      await abrirFormulario("apontamentos", null, { tarefaId: item.id });
      reabrirTarefa(item.id);
    });
    $$("[data-editar-apont]", fundo).forEach((b) =>
      b.addEventListener("click", async () => {
        fechar(null);
        await abrirFormulario("apontamentos", E.apontamentos.find((a) => a.id === b.dataset.editarApont));
        reabrirTarefa(item.id);
      }),
    );

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const dados = {};
      for (const c of campos) dados[c.k] = form.elements[c.k].value;
      for (const c of campos) {
        if (c.obrigatorio && !dados[c.k]) {
          aviso(`Preencha: ${c.rotulo.replace(" *", "")}`, true);
          form.elements[c.k].focus();
          return;
        }
      }
      let corpo = dados;
      if (colecao === "apontamentos") {
        corpo = {
          tarefaId: dados.tarefaId,
          pessoaId: dados.pessoaId,
          inicio: new Date(`${dados.data}T${dados.horaInicio}`).toISOString(),
          fim: dados.horaFim ? new Date(`${dados.data}T${dados.horaFim}`).toISOString() : null,
          nota: dados.nota,
        };
        if (!item && !corpo.fim) {
          aviso("Informe o horário de fim.", true);
          return;
        }
      }
      for (const k of ["clienteId", "projetoId", "responsavelId"]) if (k in corpo && !corpo[k]) corpo[k] = null;
      const salvo = await acao(
        () => (item ? api("PUT", `/api/${colecao}/${item.id}`, corpo) : api("POST", `/api/${colecao}`, corpo)),
        item ? "Salvo" : "Cadastrado",
      );
      if (salvo) fechar(salvo);
    });

    setTimeout(() => form.querySelector("input, select, textarea")?.focus(), 0);
  });
}

function reabrirTarefa(id) {
  const t = M.tarefas.get(id);
  if (t) abrirFormulario("tarefas", t);
}

// ---------- eventos ----------
document.addEventListener("click", async (ev) => {
  const alvo = ev.target.closest("button, a, [data-editar]");
  if (!alvo) return;
  const d = alvo.dataset;
  if (d.aba) return mostrarAba(d.aba);
  if (d.iniciar) return iniciar(d.iniciar);
  if (d.parar) return parar(d.parar);
  if (d.status) {
    const [id, status] = d.status.split(":");
    return mudarStatus(id, status);
  }
  if (d.editar) return abrirFormulario("tarefas", M.tarefas.get(d.editar));
  if (d.editarEm) {
    const [col, id] = d.editarEm.split(":");
    const item = col === "apontamentos" ? E.apontamentos.find((a) => a.id === id) : M[col].get(id);
    return abrirFormulario(col, item);
  }
  if (d.novo) return abrirFormulario(d.novo);
  if (d.novaTarefa) return abrirFormulario("tarefas", null, { projetoId: d.novaTarefa });
  if (d.novoProjetoCliente) return abrirFormulario("projetos", null, { clienteId: d.novoProjetoCliente });
  if (d.copiar) return copiar(d.copiar);
  if (d.verProjeto || d.verPessoa) {
    $("#f-projeto").value = d.verProjeto ?? "";
    $("#f-responsavel").value = d.verPessoa ?? "";
    $("#f-busca").value = "";
    mostrarAba("tarefas");
    return renderTarefas();
  }
  if (d.periodo) {
    aplicarPeriodo(d.periodo);
    return renderHoras();
  }
});

$("#rapida").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const titulo = $("#rapida-titulo").value.trim();
  if (!titulo) return;
  const corpo = {
    titulo,
    projetoId: $("#rapida-projeto").value || null,
    responsavelId: $("#rapida-responsavel").value || null,
    prazo: $("#rapida-prazo").value || "",
  };
  const criada = await acao(() => api("POST", "/api/tarefas", corpo), "Tarefa adicionada");
  if (criada) {
    $("#rapida-titulo").value = "";
    $("#rapida-prazo").value = "";
    $("#rapida-titulo").focus();
  }
});

ligarNovo($("#rapida-projeto"), "projetos");
ligarNovo($("#rapida-responsavel"), "pessoas", () => ($("#rapida-responsavel").dataset.tocado = "1"));
ligarNovo($("#eu-sou"), "pessoas", () => {
  eu = $("#eu-sou").value;
  gravarPref("eu", eu);
  delete $("#rapida-responsavel").dataset.tocado;
  render();
});

for (const id of ["#f-busca", "#f-projeto", "#f-responsavel", "#f-concluidas"]) {
  $(id).addEventListener("input", renderTarefas);
}
$("#f-concluidas").checked = lerPref("concluidas", false);
$("#f-concluidas").addEventListener("change", () => gravarPref("concluidas", $("#f-concluidas").checked));
$("#busca-projetos").addEventListener("input", renderProjetos);
$("#busca-clientes").addEventListener("input", renderClientes);
$("#h-pessoa").addEventListener("change", renderHoras);
for (const id of ["#h-de", "#h-ate"]) {
  $(id).addEventListener("change", () => {
    periodo = { tipo: "personalizado", de: $("#h-de").value, ate: $("#h-ate").value };
    $$("#periodo button").forEach((b) => b.classList.remove("ativa"));
    renderHoras();
  });
}

// Arrastar cartões entre colunas muda a situação da tarefa.
document.addEventListener("dragstart", (ev) => {
  const c = ev.target.closest?.(".cartao");
  if (!c) return;
  ev.dataTransfer.setData("text/plain", c.dataset.id);
  c.classList.add("arrastando");
});
document.addEventListener("dragend", (ev) => ev.target.closest?.(".cartao")?.classList.remove("arrastando"));
for (const col of $$("#quadro .coluna")) {
  col.addEventListener("dragover", (ev) => {
    ev.preventDefault();
    col.classList.add("alvo");
  });
  col.addEventListener("dragleave", () => col.classList.remove("alvo"));
  col.addEventListener("drop", (ev) => {
    ev.preventDefault();
    col.classList.remove("alvo");
    const id = ev.dataTransfer.getData("text/plain");
    const t = M.tarefas.get(id);
    if (t && t.status !== col.dataset.status) mudarStatus(id, col.dataset.status);
  });
}

// Atalho: tecla N foca o campo de nova tarefa.
document.addEventListener("keydown", (ev) => {
  if (ev.key.toLowerCase() !== "n" || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (ev.target.closest("input, textarea, select") || $(".fundo-modal")) return;
  ev.preventDefault();
  mostrarAba("tarefas");
  $("#rapida-titulo").focus();
});

// ---------- início ----------
aplicarPeriodo("semana");
mostrarAba(abaAtual);
carregar()
  .then(() => {
    conectarEventos();
    if (!eu && E.pessoas.length) aviso('Dica: escolha seu nome em "Eu sou" no topo da tela.');
  })
  .catch(() => aviso("Não foi possível conectar ao servidor.", true));
