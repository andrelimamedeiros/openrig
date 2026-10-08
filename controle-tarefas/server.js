// Controle de Tarefas — servidor HTTP sem dependências externas (apenas Node.js).
// Os dados ficam num único arquivo JSON dentro de DATA_DIR, que pode apontar para
// uma pasta do servidor de arquivos do escritório.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const PUBLICO = path.join(AQUI, "public");

const COLECOES = {
  clientes: ["nome", "contato", "telefone", "email", "documento", "observacoes"],
  projetos: ["nome", "codigo", "clienteId", "pasta", "status", "prazo", "observacoes"],
  pessoas: ["nome", "funcao", "email", "cor"],
  tarefas: ["titulo", "projetoId", "responsavelId", "status", "prioridade", "prazo", "descricao"],
  apontamentos: ["tarefaId", "pessoaId", "inicio", "fim", "nota"],
};

const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

const STATUS_TAREFA = ["a_fazer", "em_andamento", "concluida"];
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function estadoVazio() {
  return { versao: 0, clientes: [], projetos: [], pessoas: [], tarefas: [], apontamentos: [] };
}

class ErroHttp extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

export function criarServidor({ dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const arquivo = path.join(dataDir, "dados.json");
  const pastaBackup = path.join(dataDir, "backups");

  let estado = estadoVazio();
  if (fs.existsSync(arquivo)) {
    estado = { ...estadoVazio(), ...JSON.parse(fs.readFileSync(arquivo, "utf8")) };
  }

  const ouvintes = new Set();

  function salvar() {
    estado.versao += 1;
    const tmp = `${arquivo}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(estado, null, 2));
    fs.renameSync(tmp, arquivo);
    fazerBackupDiario();
    for (const res of ouvintes) res.write(`data: ${estado.versao}\n\n`);
  }

  function fazerBackupDiario() {
    const dia = new Date().toISOString().slice(0, 10);
    const destino = path.join(pastaBackup, `dados-${dia}.json`);
    if (fs.existsSync(destino)) return;
    fs.mkdirSync(pastaBackup, { recursive: true });
    fs.copyFileSync(arquivo, destino);
  }

  function buscar(colecao, id) {
    const item = estado[colecao].find((x) => x.id === id);
    if (!item) throw new ErroHttp(404, "Registro não encontrado.");
    return item;
  }

  function limpar(colecao, corpo, parcial) {
    const saida = {};
    for (const campo of COLECOES[colecao]) {
      if (!(campo in corpo)) continue;
      const valor = corpo[campo];
      saida[campo] = typeof valor === "string" ? valor.trim() : valor ?? null;
    }
    validar(colecao, saida, parcial);
    return saida;
  }

  function validar(colecao, dados, parcial) {
    const obrigatorio = { clientes: "nome", projetos: "nome", pessoas: "nome", tarefas: "titulo" }[colecao];
    if (obrigatorio && (!parcial || obrigatorio in dados) && !dados[obrigatorio]) {
      throw new ErroHttp(400, `O campo "${obrigatorio}" é obrigatório.`);
    }
    if (dados.clienteId) buscar("clientes", dados.clienteId);
    if (dados.projetoId) buscar("projetos", dados.projetoId);
    if (dados.responsavelId) buscar("pessoas", dados.responsavelId);
    if (dados.pessoaId) buscar("pessoas", dados.pessoaId);
    if (dados.tarefaId) buscar("tarefas", dados.tarefaId);
    if (dados.status && colecao === "tarefas" && !STATUS_TAREFA.includes(dados.status)) {
      throw new ErroHttp(400, "Status de tarefa inválido.");
    }
    if (colecao === "apontamentos") {
      for (const campo of ["inicio", "fim"]) {
        if (dados[campo] && Number.isNaN(Date.parse(dados[campo]))) {
          throw new ErroHttp(400, `Data de ${campo} inválida.`);
        }
      }
      if (dados.inicio && dados.fim && Date.parse(dados.fim) < Date.parse(dados.inicio)) {
        throw new ErroHttp(400, "O fim precisa ser depois do início.");
      }
    }
  }

  function criar(colecao, corpo) {
    const dados = limpar(colecao, corpo, false);
    const agora = new Date().toISOString();
    const item = { id: crypto.randomUUID(), criadoEm: agora, ...dados };
    if (colecao === "tarefas") {
      item.status ||= "a_fazer";
      item.prioridade ||= "normal";
    }
    if (colecao === "projetos") item.status ||= "ativo";
    if (colecao === "apontamentos" && (!item.inicio || !item.fim)) {
      throw new ErroHttp(400, "Informe início e fim para lançar horas manualmente.");
    }
    estado[colecao].push(item);
    salvar();
    return item;
  }

  function atualizar(colecao, id, corpo) {
    const item = buscar(colecao, id);
    const mudancas = limpar(colecao, corpo, true);
    if (colecao === "apontamentos") validar(colecao, { inicio: item.inicio, fim: item.fim, ...mudancas }, true);
    Object.assign(item, mudancas, { atualizadoEm: new Date().toISOString() });
    if (colecao === "tarefas" && item.status === "concluida") pararTimersDaTarefa(id);
    salvar();
    return item;
  }

  // O que some junto ao excluir: cliente -> projetos -> tarefas -> horas registradas.
  function dependentes(colecao, id) {
    const projetos = colecao === "clientes" ? estado.projetos.filter((p) => p.clienteId === id).map((p) => p.id) : colecao === "projetos" ? [id] : [];
    const tarefas =
      colecao === "tarefas" ? [id] : estado.tarefas.filter((t) => projetos.includes(t.projetoId)).map((t) => t.id);
    const apontamentos = estado.apontamentos.filter((a) => tarefas.includes(a.tarefaId)).map((a) => a.id);
    return { projetos: colecao === "clientes" ? projetos : [], tarefas: colecao === "tarefas" ? [] : tarefas, apontamentos };
  }

  // Sem "cascata", recusa excluir o que tem itens vinculados; com ela, exclui tudo junto.
  function excluir(colecao, id, cascata) {
    buscar(colecao, id);
    if (colecao === "pessoas") {
      const horas = estado.apontamentos.filter((a) => a.pessoaId === id).length;
      if (horas) {
        throw new ErroHttp(409, `Não é possível excluir: a pessoa tem ${plural(horas, "registro de horas", "registros de horas")}. Edite o cadastro em vez de excluir, para manter o histórico.`);
      }
      const tarefas = estado.tarefas.filter((t) => t.responsavelId === id);
      if (tarefas.length && !cascata) {
        throw new ErroHttp(409, `Não é possível excluir: a pessoa é responsável por ${plural(tarefas.length, "tarefa", "tarefas")}.`);
      }
      for (const t of tarefas) t.responsavelId = null;
    } else {
      const dep = dependentes(colecao, id);
      const vinculados = [
        dep.projetos.length && plural(dep.projetos.length, "projeto", "projetos"),
        dep.tarefas.length && plural(dep.tarefas.length, "tarefa", "tarefas"),
      ].filter(Boolean);
      if (vinculados.length && !cascata) {
        throw new ErroHttp(409, `Não é possível excluir: existem itens vinculados (${vinculados.join(" e ")}).`);
      }
      const fora = (lista) => (x) => !lista.includes(x.id);
      estado.projetos = estado.projetos.filter(fora(dep.projetos));
      estado.tarefas = estado.tarefas.filter(fora(dep.tarefas));
      estado.apontamentos = estado.apontamentos.filter(fora(dep.apontamentos));
    }
    estado[colecao] = estado[colecao].filter((x) => x.id !== id);
    salvar();
  }

  function pararTimersDaPessoa(pessoaId) {
    const agora = new Date().toISOString();
    for (const a of estado.apontamentos) if (a.pessoaId === pessoaId && !a.fim) a.fim = agora;
  }

  function pararTimersDaTarefa(tarefaId) {
    const agora = new Date().toISOString();
    for (const a of estado.apontamentos) if (a.tarefaId === tarefaId && !a.fim) a.fim = agora;
  }

  // Cada pessoa tem no máximo um cronômetro rodando: iniciar outro encerra o anterior.
  function iniciarTimer(tarefaId, pessoaId) {
    const tarefa = buscar("tarefas", tarefaId);
    pessoaId ||= tarefa.responsavelId;
    if (!pessoaId) throw new ErroHttp(400, "Selecione quem está executando a tarefa.");
    buscar("pessoas", pessoaId);
    pararTimersDaPessoa(pessoaId);
    if (tarefa.status !== "em_andamento") tarefa.status = "em_andamento";
    const item = {
      id: crypto.randomUUID(),
      criadoEm: new Date().toISOString(),
      tarefaId,
      pessoaId,
      inicio: new Date().toISOString(),
      fim: null,
      nota: "",
    };
    estado.apontamentos.push(item);
    salvar();
    return item;
  }

  function pararTimer(tarefaId, pessoaId) {
    const agora = new Date().toISOString();
    let parados = 0;
    for (const a of estado.apontamentos) {
      if (a.tarefaId === tarefaId && !a.fim && (!pessoaId || a.pessoaId === pessoaId)) {
        a.fim = agora;
        parados += 1;
      }
    }
    if (parados) salvar();
    return { parados };
  }

  function relatorioCsv(de, ate, pessoaId) {
    const ini = de ? Date.parse(`${de}T00:00:00`) : -Infinity;
    const fim = ate ? Date.parse(`${ate}T23:59:59.999`) : Infinity;
    const porId = (col) => new Map(estado[col].map((x) => [x.id, x]));
    const tarefas = porId("tarefas");
    const projetos = porId("projetos");
    const clientes = porId("clientes");
    const pessoas = porId("pessoas");
    const linhas = [["Data", "Início", "Fim", "Horas", "Pessoa", "Cliente", "Projeto", "Código", "Tarefa", "Nota"]];
    const ordenados = [...estado.apontamentos].sort((a, b) => a.inicio.localeCompare(b.inicio));
    for (const a of ordenados) {
      const t0 = Date.parse(a.inicio);
      if (t0 < ini || t0 > fim || (pessoaId && a.pessoaId !== pessoaId)) continue;
      const t1 = a.fim ? Date.parse(a.fim) : Date.now();
      const tarefa = tarefas.get(a.tarefaId);
      const projeto = projetos.get(tarefa?.projetoId);
      const cliente = clientes.get(projeto?.clienteId);
      const d0 = new Date(t0);
      const d1 = new Date(t1);
      linhas.push([
        d0.toLocaleDateString("pt-BR"),
        d0.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
        a.fim ? d1.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "em andamento",
        ((t1 - t0) / 3_600_000).toFixed(2).replace(".", ","),
        pessoas.get(a.pessoaId)?.nome ?? "",
        cliente?.nome ?? "",
        projeto?.nome ?? "",
        projeto?.codigo ?? "",
        tarefa?.titulo ?? "",
        a.nota ?? "",
      ]);
    }
    const celula = (v) => `"${String(v).replaceAll('"', '""')}"`;
    // BOM + ";" para o Excel em português abrir com acentos e colunas corretas.
    return "﻿" + linhas.map((l) => l.map(celula).join(";")).join("\r\n");
  }

  async function lerCorpo(req) {
    let texto = "";
    for await (const parte of req) {
      texto += parte;
      if (texto.length > 1_000_000) throw new ErroHttp(413, "Requisição muito grande.");
    }
    if (!texto) return {};
    try {
      return JSON.parse(texto);
    } catch {
      throw new ErroHttp(400, "JSON inválido.");
    }
  }

  function json(res, status, corpo) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(corpo));
  }

  function servirArquivo(res, caminhoUrl) {
    const relativo = caminhoUrl === "/" ? "index.html" : decodeURIComponent(caminhoUrl).replace(/^\/+/, "");
    const alvo = path.resolve(PUBLICO, relativo);
    if (!alvo.startsWith(PUBLICO + path.sep) || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Não encontrado");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(alvo)] ?? "application/octet-stream" });
    fs.createReadStream(alvo).pipe(res);
  }

  async function tratar(req, res) {
    const url = new URL(req.url, "http://localhost");
    const partes = url.pathname.split("/").filter(Boolean);
    if (partes[0] !== "api") return servirArquivo(res, url.pathname);

    const [, recurso, id, acao] = partes;
    const metodo = req.method;

    if (recurso === "estado" && metodo === "GET") return json(res, 200, estado);

    if (recurso === "eventos" && metodo === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write(`data: ${estado.versao}\n\n`);
      ouvintes.add(res);
      const pulso = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(pulso);
        ouvintes.delete(res);
      });
      return;
    }

    if (recurso === "relatorio.csv" && metodo === "GET") {
      const csv = relatorioCsv(url.searchParams.get("de"), url.searchParams.get("ate"), url.searchParams.get("pessoaId"));
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="horas.csv"',
      });
      return res.end(csv);
    }

    if (recurso === "tarefas" && id && (acao === "iniciar" || acao === "parar") && metodo === "POST") {
      const corpo = await lerCorpo(req);
      const resultado = acao === "iniciar" ? iniciarTimer(id, corpo.pessoaId) : pararTimer(id, corpo.pessoaId);
      return json(res, 200, resultado);
    }

    if (!(recurso in COLECOES) || acao) throw new ErroHttp(404, "Rota não encontrada.");

    if (!id && metodo === "GET") return json(res, 200, estado[recurso]);
    if (!id && metodo === "POST") return json(res, 201, criar(recurso, await lerCorpo(req)));
    if (id && metodo === "GET") return json(res, 200, buscar(recurso, id));
    if (id && (metodo === "PUT" || metodo === "PATCH")) return json(res, 200, atualizar(recurso, id, await lerCorpo(req)));
    if (id && metodo === "DELETE") {
      excluir(recurso, id, url.searchParams.get("cascata") === "1");
      res.writeHead(204);
      return res.end();
    }
    throw new ErroHttp(405, "Método não permitido.");
  }

  const servidor = http.createServer((req, res) => {
    tratar(req, res).catch((erro) => {
      const status = erro instanceof ErroHttp ? erro.status : 500;
      if (status === 500) console.error(erro);
      if (!res.headersSent) json(res, status, { erro: status === 500 ? "Erro interno no servidor." : erro.message });
      else res.end();
    });
  });
  servidor.on("close", () => {
    for (const res of ouvintes) res.end();
    ouvintes.clear();
  });
  return servidor;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const porta = Number(process.env.PORTA ?? process.env.PORT ?? 3000);
  const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(AQUI, "dados"));
  criarServidor({ dataDir }).listen(porta, "0.0.0.0", () => {
    console.log(`Controle de Tarefas rodando em http://localhost:${porta}`);
    console.log(`Dados salvos em ${path.join(dataDir, "dados.json")}`);
    console.log("Os outros computadores acessam pelo nome ou IP deste servidor, na mesma porta.");
  });
}
