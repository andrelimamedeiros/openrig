# Controle de Tarefas

Ferramenta simples para a equipe controlar **tarefas**, **responsáveis**, **tempo gasto**, **projetos** e **clientes**.
Roda em um computador/servidor do escritório e todos acessam pelo navegador — nada para instalar nas máquinas da equipe.

## O que dá para fazer

- **Adicionar tarefa em um passo:** digite o que precisa ser feito, escolha projeto e responsável e tecle **Enter** (atalho: tecla **N** em qualquer tela).
- **Quadro de tarefas:** A fazer → Em andamento → Concluídas. Arraste os cartões entre colunas ou use **✓** para concluir.
- **Cronômetro por tarefa:** **▶ Iniciar** e **■ Parar**. Cada pessoa tem um cronômetro por vez: ao iniciar outra tarefa, o anterior é encerrado automaticamente. O cronômetro ativo aparece no topo da tela.
- **Lançar horas esquecidas:** em *Horas → + Lançar horas* ou dentro da tarefa.
- **Cadastros rápidos:** em qualquer lista de seleção há a opção “+ Novo…”, que abre o cadastro sem sair do que você está fazendo (ex.: criar o cliente enquanto cadastra o projeto).
- **Projetos com pasta no servidor:** informe o caminho da documentação (ex.: `\\servidor\Projetos\2026-014`). O botão 📋 copia o caminho para colar no Explorador de Arquivos.
- **Clientes:** contato, telefone, e-mail, CNPJ/CPF, projetos ativos e horas lançadas.
- **Equipe:** quem está trabalhando em quê agora, e horas de hoje e da semana.
- **Horas:** totais por projeto, cliente e pessoa (hoje, semana, mês ou período livre) e **exportação para Excel** (CSV).
- **Tudo atualiza sozinho:** o que um colega muda aparece na tela dos outros na hora.

## Instalação (uma vez, no servidor)

1. Instale o **Node.js** (versão 20 ou mais nova) em <https://nodejs.org> no computador que ficará ligado como servidor.
2. Copie a pasta `controle-tarefas` para esse computador.
3. Dê dois cliques em **`iniciar.bat`** (Windows) ou rode `./iniciar.sh` (Linux/macOS).
4. Nos computadores da equipe, abra no navegador: `http://NOME-DO-SERVIDOR:3000`
   (ou o IP, por exemplo `http://192.168.0.10:3000`). Crie um atalho na área de trabalho.

> Se não abrir nos outros computadores, libere a porta 3000 no Firewall do Windows do servidor.

No primeiro acesso, cada pessoa escolhe o próprio nome em **“Eu sou”**, no topo. O navegador lembra dessa escolha.

## Onde ficam os dados

Tudo fica em um único arquivo: `dados/dados.json`, dentro da pasta do aplicativo. Uma cópia de segurança diária é criada automaticamente em `dados/backups/`.

Para guardar os dados em outra pasta do servidor (por exemplo, uma que já entra no backup da empresa), edite o `iniciar.bat` e ajuste a linha:

```bat
set DATA_DIR=D:\Compartilhado\ControleTarefas
```

Para mudar a porta, altere `set PORTA=3000`.

> Rode **apenas um** servidor por pasta de dados. Os usuários acessam pelo navegador; não abra o `dados.json` diretamente enquanto o sistema estiver em uso.

## Deixar iniciando com o Windows (opcional)

Coloque um atalho do `iniciar.bat` em `shell:startup` (Win + R → `shell:startup`) no servidor.
Para rodar como serviço, mesmo sem ninguém logado, use o [NSSM](https://nssm.cc/) apontando para `node.exe` com o argumento `server.js`.

## Para quem for manter o sistema

- Sem dependências externas: apenas Node.js. Servidor em `server.js`, interface em `public/`.
- Testes: `npm test`.
- API JSON em `/api`: `GET /api/estado`; `GET|POST /api/{clientes|projetos|pessoas|tarefas|apontamentos}`; `PUT|DELETE /api/{coleção}/{id}`; `POST /api/tarefas/{id}/iniciar|parar`; `GET /api/relatorio.csv?de=AAAA-MM-DD&ate=AAAA-MM-DD`.
- Não há login: o sistema foi pensado para a rede interna do escritório. Não exponha a porta na internet.
