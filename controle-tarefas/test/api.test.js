import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { criarServidor } from "../server.js";

let servidor;
let base;
let dataDir;

async function req(metodo, url, corpo) {
  const res = await fetch(base + url, {
    method: metodo,
    headers: corpo ? { "content-type": "application/json" } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const texto = await res.text();
  return { status: res.status, corpo: texto && res.headers.get("content-type")?.includes("json") ? JSON.parse(texto) : texto };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "controle-tarefas-"));
  servidor = criarServidor({ dataDir });
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

after(() => {
  servidor.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("fluxo completo: cadastros, tarefa, cronômetro, relatório", async () => {
  const cliente = (await req("POST", "/api/clientes", { nome: "Construtora Alfa", telefone: "11 99999-0000" })).corpo;
  const projeto = (
    await req("POST", "/api/projetos", { nome: "Residencial Sol", codigo: "2026-014", clienteId: cliente.id, pasta: "\\\\servidor\\Projetos\\2026-014" })
  ).corpo;
  assert.equal(projeto.status, "ativo");
  const ana = (await req("POST", "/api/pessoas", { nome: "Ana Souza" })).corpo;

  const tarefa = (await req("POST", "/api/tarefas", { titulo: "Planta baixa", projetoId: projeto.id, responsavelId: ana.id })).corpo;
  assert.equal(tarefa.status, "a_fazer");

  const timer = await req("POST", `/api/tarefas/${tarefa.id}/iniciar`, {});
  assert.equal(timer.status, 200);
  assert.equal(timer.corpo.pessoaId, ana.id, "sem pessoa explícita, cronometra para o responsável");

  let estado = (await req("GET", "/api/estado")).corpo;
  assert.equal(estado.tarefas[0].status, "em_andamento");
  assert.equal(estado.apontamentos.filter((a) => !a.fim).length, 1);

  // Iniciar outra tarefa encerra o cronômetro anterior da mesma pessoa.
  const outra = (await req("POST", "/api/tarefas", { titulo: "Memorial", projetoId: projeto.id })).corpo;
  await req("POST", `/api/tarefas/${outra.id}/iniciar`, { pessoaId: ana.id });
  estado = (await req("GET", "/api/estado")).corpo;
  const rodando = estado.apontamentos.filter((a) => !a.fim);
  assert.equal(rodando.length, 1);
  assert.equal(rodando[0].tarefaId, outra.id);

  // Concluir a tarefa para o cronômetro dela.
  await req("PUT", `/api/tarefas/${outra.id}`, { status: "concluida" });
  estado = (await req("GET", "/api/estado")).corpo;
  assert.equal(estado.apontamentos.filter((a) => !a.fim).length, 0);

  // Lançamento manual de horas.
  const manual = await req("POST", "/api/apontamentos", {
    tarefaId: tarefa.id,
    pessoaId: ana.id,
    inicio: "2026-10-01T12:00:00.000Z",
    fim: "2026-10-01T13:30:00.000Z",
    nota: "Reunião com cliente",
  });
  assert.equal(manual.status, 201);

  const csv = await req("GET", "/api/relatorio.csv?de=2026-09-30&ate=2026-10-02");
  assert.equal(csv.status, 200);
  assert.match(csv.corpo, /"1,50";"Ana Souza";"Construtora Alfa";"Residencial Sol";"2026-014";"Planta baixa";"Reunião com cliente"/);

  // Dados persistidos em disco e recarregados por um novo servidor.
  const salvo = JSON.parse(fs.readFileSync(path.join(dataDir, "dados.json"), "utf8"));
  assert.equal(salvo.tarefas.length, 2);
  assert.ok(fs.readdirSync(path.join(dataDir, "backups")).length >= 1);
});

test("validações e proteção de exclusão", async () => {
  assert.equal((await req("POST", "/api/clientes", { nome: "  " })).status, 400);
  assert.equal((await req("POST", "/api/tarefas", { titulo: "X", projetoId: "nao-existe" })).status, 404);
  const pessoa = (await req("POST", "/api/pessoas", { nome: "Bruno" })).corpo;
  const tarefa = (await req("POST", "/api/tarefas", { titulo: "Y" })).corpo;
  assert.equal((await req("POST", `/api/tarefas/${tarefa.id}/iniciar`, {})).status, 400, "sem responsável nem pessoa");
  assert.equal(
    (await req("POST", "/api/apontamentos", { tarefaId: tarefa.id, pessoaId: pessoa.id, inicio: "2026-10-01T10:00:00Z", fim: "2026-10-01T09:00:00Z" })).status,
    400,
  );

  const cliente = (await req("POST", "/api/clientes", { nome: "Beta" })).corpo;
  await req("POST", "/api/projetos", { nome: "P", clienteId: cliente.id });
  const r = await req("DELETE", `/api/clientes/${cliente.id}`);
  assert.equal(r.status, 409);
  assert.match(r.corpo.erro, /projetos vinculados/);

  assert.equal((await req("DELETE", `/api/tarefas/${tarefa.id}`)).status, 204);
});

test("serve a interface e bloqueia acesso fora da pasta pública", async () => {
  const pagina = await req("GET", "/");
  assert.equal(pagina.status, 200);
  assert.match(pagina.corpo, /Controle de Tarefas/);
  assert.equal((await req("GET", "/..%2Fserver.js")).status, 404);
});
