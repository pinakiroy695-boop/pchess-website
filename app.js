const PIECE_FALLBACK = {
  wp: "\u2659", wr: "\u2656", wn: "\u2658", wb: "\u2657", wq: "\u2655", wk: "\u2654",
  bp: "\u265F", br: "\u265C", bn: "\u265E", bb: "\u265D", bq: "\u265B", bk: "\u265A"
};

const PIECE_IMG = {
  wp: "https://images.chesscomfiles.com/chess-themes/pieces/neo/150/wp.png",
  wr: "https://images.chesscomfiles.com/chess-themes/pieces/neo/150/wr.png",
  wn: "https://images.chesscomfiles.com/chess-themes/pieces/neo/150/wn.png",
  wb: "https://images.chesscomfiles.com/chess-themes/pieces/neo/150/wb.png",
  wq: "https://images.chesscomfiles.com/chess-themes/pieces/neo/150/wq.png",
  wk: "https://images.chesscomfiles.com/chess-themes/pieces/neo/150/wk.png",
  bp: "https://images.chesscomfiles.com/chess-themes/pieces/neo/150/bp.png",
  br: "https://images.chesscomfiles.com/chess-themes/pieces/neo/150/br.png",
  bn: "https://images.chesscomfiles.com/chess-themes/pieces/neo/150/bn.png",
  bb: "https://images.chesscomfiles.com/chess-themes/pieces/neo/150/bb.png",
  bq: "https://images.chesscomfiles.com/chess-themes/pieces/neo/150/bq.png",
  bk: "https://images.chesscomfiles.com/chess-themes/pieces/neo/150/bk.png"
};

const boardEl = document.getElementById("board");
const turnEl = document.getElementById("turn");
const statusEl = document.getElementById("status");
const newGameBtn = document.getElementById("newGame");
const flipBoardBtn = document.getElementById("flipBoard");
const vsComputerBtn = document.getElementById("vsComputer");
const computerRatingEl = document.getElementById("computerRating");
const ratingValueEl = document.getElementById("ratingValue");

const STOCKFISH_SOURCES = [
  "https://cdn.jsdelivr.net/npm/stockfish@16.0.0/src/stockfish-nnue-16-single.js",
  "https://unpkg.com/stockfish@16.0.0/src/stockfish-nnue-16-single.js"
];
const STOCKFISH_VERIFY_TIMEOUT_MS = 6000;

let board = [];
let turn = "w";
let selected = null;
let legalMoves = [];
let orientation = "w";
let castling = { wK: true, wQ: true, bK: true, bQ: true };
let enPassant = null;
let gameOver = false;
let lastMove = null;
let draggedFrom = null;
let vsComputer = true;
const computerColor = "b";
let aiThinking = false;
let aiTimer = null;
let halfmoveClock = 0;
let fullmoveNumber = 1;
let stockfish = null;
let stockfishReady = false;
let stockfishFailed = false;
let stockfishLoading = false;
let awaitingBestMove = false;
let pendingFallbackMove = null;
let computerElo = Number(computerRatingEl?.value || 2800);
let stockfishRetryAfterMs = 0;
const AI_THINK_START_DELAY_MS = 110;
const AI_MOVE_COMMIT_DELAY_MS = 180;

function initialBoard() {
  return [
    ["br", "bn", "bb", "bq", "bk", "bb", "bn", "br"],
    ["bp", "bp", "bp", "bp", "bp", "bp", "bp", "bp"],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    [null, null, null, null, null, null, null, null],
    ["wp", "wp", "wp", "wp", "wp", "wp", "wp", "wp"],
    ["wr", "wn", "wb", "wq", "wk", "wb", "wn", "wr"]
  ];
}

function updateRatingLabel() {
  if (ratingValueEl) ratingValueEl.textContent = String(computerElo);
}

function postStockfish(command) {
  if (!stockfish) return;
  stockfish.postMessage(command);
}

function applyStockfishOptions() {
  if (!stockfishReady) return;
  const threads = Math.max(1, Math.min(2, Number(navigator.hardwareConcurrency || 1)));
  postStockfish(`setoption name Threads value ${threads}`);
  postStockfish("setoption name Hash value 128");
  const unlimited = computerElo >= 2800;
  postStockfish(`setoption name UCI_LimitStrength value ${unlimited ? "false" : "true"}`);
  if (!unlimited) {
    postStockfish(`setoption name UCI_Elo value ${computerElo}`);
  }
  const skillLevel = Math.max(0, Math.min(20, Math.round((computerElo - 1000) / 70)));
  postStockfish(`setoption name Skill Level value ${skillLevel}`);
}

function destroyStockfishWorker(worker) {
  if (!worker) return;
  try {
    worker.terminate();
  } catch (_) {}
  const blobUrl = worker.__blobUrl || null;
  if (blobUrl) {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch (_) {}
  }
}

async function createStockfishWorkerFromSource(url) {
  const response = await fetch(url, { cache: "default" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const source = await response.text();
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
  try {
    const worker = new Worker(blobUrl);
    worker.__blobUrl = blobUrl;
    return worker;
  } catch (error) {
    URL.revokeObjectURL(blobUrl);
    throw error;
  }
}

function verifyStockfishWorker(worker, timeoutMs = STOCKFISH_VERIFY_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      resolve(ok);
    };
    const onMessage = (event) => {
      const line = String(event.data || "").trim();
      if (line === "uciok") done(true);
    };
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    try {
      worker.postMessage("uci");
    } catch (_) {
      done(false);
    }
  });
}

async function buildStockfishWorker() {
  for (const url of STOCKFISH_SOURCES) {
    let worker = null;
    try {
      worker = await createStockfishWorkerFromSource(url);
      const verified = await verifyStockfishWorker(worker);
      if (verified) return worker;
    } catch (_) {
      // Try next source.
    }
    destroyStockfishWorker(worker);
  }
  return null;
}

async function initStockfish() {
  stockfishLoading = true;
  stockfishReady = false;
  stockfishFailed = false;
  awaitingBestMove = false;
  destroyStockfishWorker(stockfish);
  stockfish = null;

  const worker = await buildStockfishWorker();
  stockfishLoading = false;
  if (!worker) {
    stockfishReady = false;
    stockfishFailed = true;
    stockfishRetryAfterMs = Date.now() + 10000;
    if (isComputerTurn()) setStatus("Stockfish failed to load.");
    return;
  }
  stockfish = worker;

  try {
    stockfish.onerror = () => {
      stockfishReady = false;
      stockfishFailed = true;
      stockfishRetryAfterMs = Date.now() + 10000;
      stockfishLoading = false;
      awaitingBestMove = false;
      aiThinking = false;
      if (isComputerTurn()) {
        setStatus("Stockfish failed to load.");
      }
    };

    stockfish.onmessage = (event) => {
      const line = String(event.data || "").trim();
      if (!line) return;

      if (line === "uciok") {
        postStockfish("isready");
        return;
      }
      if (line === "readyok") {
        stockfishReady = true;
        applyStockfishOptions();
        if (isComputerTurn() && !aiThinking) scheduleComputerMove();
        return;
      }
      if (!line.startsWith("bestmove ")) return;
      if (!awaitingBestMove) return;

      const moveText = line.split(/\s+/)[1];
      awaitingBestMove = false;
      if (!isComputerTurn() || !moveText || moveText === "(none)") {
        aiThinking = false;
        return;
      }
      const parsed = parseUciMove(moveText);
      if (!parsed) {
        aiThinking = false;
        makeFallbackComputerMove();
        return;
      }
      const choices = legalMovesFor(board, parsed.from.r, parsed.from.c);
      const chosen = choices.find(mv => mv.r === parsed.to.r && mv.c === parsed.to.c) || null;
      aiThinking = false;
      if (chosen) {
        movePiece(parsed.from, chosen);
      } else {
        makeFallbackComputerMove();
      }
    };

    postStockfish("uci");
  } catch (_) {
    destroyStockfishWorker(stockfish);
    stockfish = null;
    stockfishReady = false;
    stockfishFailed = true;
    stockfishRetryAfterMs = Date.now() + 10000;
    stockfishLoading = false;
  }
}

function resetGame() {
  if (aiTimer) {
    clearTimeout(aiTimer);
    aiTimer = null;
  }
  board = initialBoard();
  turn = "w";
  selected = null;
  legalMoves = [];
  castling = { wK: true, wQ: true, bK: true, bQ: true };
  enPassant = null;
  gameOver = false;
  lastMove = null;
  draggedFrom = null;
  aiThinking = false;
  awaitingBestMove = false;
  pendingFallbackMove = null;
  halfmoveClock = 0;
  fullmoveNumber = 1;
  updateVsComputerButton();
  updateRatingLabel();
  if (stockfish) {
    postStockfish("stop");
    postStockfish("ucinewgame");
    postStockfish("isready");
  }
  if (vsComputer && stockfishFailed) {
    setStatus("Stockfish failed to load.");
  } else {
    setStatus("Select a piece to move.");
  }
  render();
  scheduleComputerMove();
}

function cloneBoard(src) {
  return src.map(row => row.slice());
}

function inBounds(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function colorOf(piece) {
  return piece ? piece[0] : null;
}

function enemyOf(color) {
  return color === "w" ? "b" : "w";
}

function toAlgebraic(r, c) {
  return `${String.fromCharCode(97 + c)}${8 - r}`;
}

function fromAlgebraic(square) {
  if (!square || square.length !== 2) return null;
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]);
  if (!Number.isInteger(rank)) return null;
  const r = 8 - rank;
  const c = file;
  if (!inBounds(r, c)) return null;
  return { r, c };
}

function parseUciMove(uciMove) {
  if (!uciMove || uciMove.length < 4) return null;
  const from = fromAlgebraic(uciMove.slice(0, 2));
  const to = fromAlgebraic(uciMove.slice(2, 4));
  if (!from || !to) return null;
  return { from, to, promotion: uciMove[4] || null };
}

function fenPiece(piece) {
  if (!piece) return "";
  const type = piece[1];
  return piece[0] === "w" ? type.toUpperCase() : type;
}

function boardToFen() {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    let row = "";
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) {
        empty++;
      } else {
        if (empty) {
          row += String(empty);
          empty = 0;
        }
        row += fenPiece(piece);
      }
    }
    if (empty) row += String(empty);
    rows.push(row);
  }

  let castle = "";
  if (castling.wK) castle += "K";
  if (castling.wQ) castle += "Q";
  if (castling.bK) castle += "k";
  if (castling.bQ) castle += "q";
  if (!castle) castle = "-";

  const ep = enPassant ? toAlgebraic(enPassant.r, enPassant.c) : "-";
  return `${rows.join("/")} ${turn} ${castle} ${ep} ${halfmoveClock} ${fullmoveNumber}`;
}

function findKing(src, color) {
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (src[r][c] === `${color}k`) return { r, c };
    }
  }
  return null;
}

function attacksSquare(src, fromR, fromC, toR, toC) {
  const piece = src[fromR][fromC];
  if (!piece) return false;
  const color = piece[0];
  const type = piece[1];
  const dr = toR - fromR;
  const dc = toC - fromC;

  if (type === "p") {
    const dir = color === "w" ? -1 : 1;
    return dr === dir && Math.abs(dc) === 1;
  }

  if (type === "n") {
    return (Math.abs(dr) === 2 && Math.abs(dc) === 1) || (Math.abs(dr) === 1 && Math.abs(dc) === 2);
  }

  if (type === "k") {
    return Math.max(Math.abs(dr), Math.abs(dc)) === 1;
  }

  const isDiag = Math.abs(dr) === Math.abs(dc);
  const isStraight = dr === 0 || dc === 0;
  if (type === "b" && !isDiag) return false;
  if (type === "r" && !isStraight) return false;
  if (type === "q" && !(isDiag || isStraight)) return false;

  const stepR = dr === 0 ? 0 : dr / Math.abs(dr);
  const stepC = dc === 0 ? 0 : dc / Math.abs(dc);
  let r = fromR + stepR;
  let c = fromC + stepC;
  while (r !== toR || c !== toC) {
    if (src[r][c]) return false;
    r += stepR;
    c += stepC;
  }
  return true;
}

function isInCheck(src, color) {
  const king = findKing(src, color);
  if (!king) return false;
  const enemy = enemyOf(color);
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (src[r][c] && src[r][c][0] === enemy) {
        if (attacksSquare(src, r, c, king.r, king.c)) return true;
      }
    }
  }
  return false;
}

function pushRayMoves(src, r, c, dirs, moves) {
  const color = src[r][c][0];
  for (const [dr, dc] of dirs) {
    let nr = r + dr;
    let nc = c + dc;
    while (inBounds(nr, nc)) {
      const target = src[nr][nc];
      if (!target) {
        moves.push({ r: nr, c: nc });
      } else {
        if (target[0] !== color) moves.push({ r: nr, c: nc, capture: true });
        break;
      }
      nr += dr;
      nc += dc;
    }
  }
}

function pseudoMoves(src, r, c) {
  const piece = src[r][c];
  if (!piece) return [];
  const color = piece[0];
  const type = piece[1];
  const moves = [];

  if (type === "p") {
    const dir = color === "w" ? -1 : 1;
    const startRow = color === "w" ? 6 : 1;
    const oneStep = r + dir;

    if (inBounds(oneStep, c) && !src[oneStep][c]) {
      moves.push({ r: oneStep, c, pawnPush: true });
      const twoStep = r + 2 * dir;
      if (r === startRow && !src[twoStep][c]) {
        moves.push({ r: twoStep, c, doublePawn: true, pawnPush: true });
      }
    }

    for (const dc of [-1, 1]) {
      const nr = r + dir;
      const nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const target = src[nr][nc];
      if (target && target[0] !== color) {
        moves.push({ r: nr, c: nc, capture: true });
      }
      if (!target && enPassant && enPassant.r === nr && enPassant.c === nc) {
        moves.push({ r: nr, c: nc, enPassant: true, capture: true });
      }
    }
  }

  if (type === "n") {
    const jumps = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
    for (const [dr, dc] of jumps) {
      const nr = r + dr;
      const nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      const target = src[nr][nc];
      if (!target || target[0] !== color) moves.push({ r: nr, c: nc, capture: !!target });
    }
  }

  if (type === "b") pushRayMoves(src, r, c, [[-1, -1], [-1, 1], [1, -1], [1, 1]], moves);
  if (type === "r") pushRayMoves(src, r, c, [[-1, 0], [1, 0], [0, -1], [0, 1]], moves);
  if (type === "q") pushRayMoves(src, r, c, [[-1, -1], [-1, 1], [1, -1], [1, 1], [-1, 0], [1, 0], [0, -1], [0, 1]], moves);

  if (type === "k") {
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (dr === 0 && dc === 0) continue;
        const nr = r + dr;
        const nc = c + dc;
        if (!inBounds(nr, nc)) continue;
        const target = src[nr][nc];
        if (!target || target[0] !== color) moves.push({ r: nr, c: nc, capture: !!target });
      }
    }

    const homeRow = color === "w" ? 7 : 0;
    const inCheck = isInCheck(src, color);
    if (!inCheck && r === homeRow && c === 4) {
      const canK = color === "w" ? castling.wK : castling.bK;
      const canQ = color === "w" ? castling.wQ : castling.bQ;

      if (canK && !src[homeRow][5] && !src[homeRow][6]) {
        if (!wouldSquareBeAttacked(src, color, homeRow, 5) && !wouldSquareBeAttacked(src, color, homeRow, 6)) {
          moves.push({ r: homeRow, c: 6, castle: "kingside" });
        }
      }

      if (canQ && !src[homeRow][3] && !src[homeRow][2] && !src[homeRow][1]) {
        if (!wouldSquareBeAttacked(src, color, homeRow, 3) && !wouldSquareBeAttacked(src, color, homeRow, 2)) {
          moves.push({ r: homeRow, c: 2, castle: "queenside" });
        }
      }
    }
  }

  return moves;
}

function wouldSquareBeAttacked(src, color, r, c) {
  const enemy = enemyOf(color);
  for (let rr = 0; rr < 8; rr++) {
    for (let cc = 0; cc < 8; cc++) {
      const p = src[rr][cc];
      if (p && p[0] === enemy && attacksSquare(src, rr, cc, r, c)) return true;
    }
  }
  return false;
}

function simulateMove(src, from, move) {
  const next = cloneBoard(src);
  const piece = next[from.r][from.c];
  next[from.r][from.c] = null;

  if (move.enPassant) {
    const dir = piece[0] === "w" ? 1 : -1;
    next[move.r + dir][move.c] = null;
  }

  next[move.r][move.c] = piece;

  if (move.castle) {
    const row = piece[0] === "w" ? 7 : 0;
    if (move.castle === "kingside") {
      next[row][5] = next[row][7];
      next[row][7] = null;
    } else {
      next[row][3] = next[row][0];
      next[row][0] = null;
    }
  }

  if (piece[1] === "p" && (move.r === 0 || move.r === 7)) {
    next[move.r][move.c] = `${piece[0]}q`;
  }

  return next;
}

function legalMovesFor(src, r, c) {
  const piece = src[r][c];
  if (!piece || piece[0] !== turn) return [];
  return pseudoMoves(src, r, c).filter(mv => {
    const after = simulateMove(src, { r, c }, mv);
    return !isInCheck(after, piece[0]);
  });
}

function allLegalMoves(src, color) {
  const all = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (src[r][c] && src[r][c][0] === color) {
        const wasTurn = turn;
        turn = color;
        const moves = legalMovesFor(src, r, c);
        turn = wasTurn;
        for (const mv of moves) all.push({ from: { r, c }, to: mv });
      }
    }
  }
  return all;
}

function movePiece(from, move) {
  const piece = board[from.r][from.c];
  const target = board[move.r][move.c];
  const wasBlackMove = turn === "b";
  const isCapture = !!target || !!move.enPassant;

  if (piece === "wk") {
    castling.wK = false;
    castling.wQ = false;
  }
  if (piece === "bk") {
    castling.bK = false;
    castling.bQ = false;
  }
  if (piece === "wr" && from.r === 7 && from.c === 0) castling.wQ = false;
  if (piece === "wr" && from.r === 7 && from.c === 7) castling.wK = false;
  if (piece === "br" && from.r === 0 && from.c === 0) castling.bQ = false;
  if (piece === "br" && from.r === 0 && from.c === 7) castling.bK = false;

  if (target === "wr" && move.r === 7 && move.c === 0) castling.wQ = false;
  if (target === "wr" && move.r === 7 && move.c === 7) castling.wK = false;
  if (target === "br" && move.r === 0 && move.c === 0) castling.bQ = false;
  if (target === "br" && move.r === 0 && move.c === 7) castling.bK = false;

  board = simulateMove(board, from, move);
  lastMove = { from: { r: from.r, c: from.c }, to: { r: move.r, c: move.c } };

  if (piece[1] === "p" && move.doublePawn) {
    const dir = piece[0] === "w" ? -1 : 1;
    enPassant = { r: from.r + dir, c: from.c };
  } else {
    enPassant = null;
  }

  if (piece[1] === "p" || isCapture) {
    halfmoveClock = 0;
  } else {
    halfmoveClock += 1;
  }
  if (wasBlackMove) fullmoveNumber += 1;

  turn = enemyOf(turn);
  selected = null;
  legalMoves = [];

  const check = isInCheck(board, turn);
  const replies = allLegalMoves(board, turn);

  if (replies.length === 0) {
    gameOver = true;
    if (check) {
      setStatus(`Checkmate. ${turn === "w" ? "Black" : "White"} wins.`);
    } else {
      setStatus("Stalemate.");
    }
  } else {
    if (isComputerTurn()) {
      setStatus("Computer is thinking...");
    } else {
      setStatus(check ? "Check." : "Select a piece to move.");
    }
  }

  render();
  scheduleComputerMove();
}

function setStatus(text) {
  statusEl.textContent = text;
}

function displayRowCol(viewRow, viewCol) {
  if (orientation === "w") return { r: viewRow, c: viewCol };
  return { r: 7 - viewRow, c: 7 - viewCol };
}

function isLegalTarget(r, c) {
  return legalMoves.find(m => m.r === r && m.c === c) || null;
}

function onSquareClick(r, c) {
  if (gameOver || isComputerTurn() || aiThinking) return;
  const piece = board[r][c];

  if (!selected) {
    if (!piece || piece[0] !== turn) return;
    selected = { r, c };
    legalMoves = legalMovesFor(board, r, c);
    render();
    return;
  }

  const move = isLegalTarget(r, c);
  if (move) {
    movePiece(selected, move);
    return;
  }

  if (piece && piece[0] === turn) {
    selected = { r, c };
    legalMoves = legalMovesFor(board, r, c);
  } else {
    selected = null;
    legalMoves = [];
  }
  render();
}

function onDragStart(event, r, c) {
  if (gameOver || isComputerTurn() || aiThinking) {
    event.preventDefault();
    return;
  }
  const piece = board[r][c];
  if (!piece || piece[0] !== turn) {
    event.preventDefault();
    return;
  }

  draggedFrom = { r, c };
  event.dataTransfer.effectAllowed = "move";
  // Required for drop to work reliably in some browsers.
  event.dataTransfer.setData("text/plain", `${r},${c}`);
}

function onDragOver(event) {
  if (!draggedFrom) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
}

function onDrop(event, r, c) {
  event.preventDefault();
  if (!draggedFrom || gameOver || isComputerTurn() || aiThinking) return;

  const moves = legalMovesFor(board, draggedFrom.r, draggedFrom.c);
  const move = moves.find(m => m.r === r && m.c === c);
  if (move) {
    movePiece(draggedFrom, move);
  }
  draggedFrom = null;
}

function onDragEnd() {
  draggedFrom = null;
}

function isComputerTurn() {
  return vsComputer && turn === computerColor && !gameOver;
}

function updateVsComputerButton() {
  if (!vsComputerBtn) return;
  vsComputerBtn.textContent = `Vs Stockfish: ${vsComputer ? "On" : "Off"}`;
}

function pieceValue(piece) {
  if (!piece) return 0;
  const values = { p: 1, n: 3, b: 3.2, r: 5, q: 9, k: 100 };
  return values[piece[1]] || 0;
}

function cloneCastlingRights(rights) {
  return { wK: rights.wK, wQ: rights.wQ, bK: rights.bK, bQ: rights.bQ };
}

function withState(state, fn) {
  const prevTurn = turn;
  const prevCastling = castling;
  const prevEnPassant = enPassant;
  turn = state.turn;
  castling = state.castling;
  enPassant = state.enPassant;
  try {
    return fn();
  } finally {
    turn = prevTurn;
    castling = prevCastling;
    enPassant = prevEnPassant;
  }
}

function allLegalMovesState(state, color) {
  return withState({ ...state, turn: color }, () => allLegalMoves(state.board, color));
}

function stateFromCurrentBoard() {
  return {
    board: cloneBoard(board),
    turn,
    castling: cloneCastlingRights(castling),
    enPassant: enPassant ? { r: enPassant.r, c: enPassant.c } : null
  };
}

function applyMoveToState(state, entry) {
  const nextBoard = simulateMove(state.board, entry.from, entry.to);
  const moving = state.board[entry.from.r][entry.from.c];
  const target = state.board[entry.to.r][entry.to.c];
  const nextCastling = cloneCastlingRights(state.castling);
  let nextEnPassant = null;

  if (moving === "wk") {
    nextCastling.wK = false;
    nextCastling.wQ = false;
  }
  if (moving === "bk") {
    nextCastling.bK = false;
    nextCastling.bQ = false;
  }
  if (moving === "wr" && entry.from.r === 7 && entry.from.c === 0) nextCastling.wQ = false;
  if (moving === "wr" && entry.from.r === 7 && entry.from.c === 7) nextCastling.wK = false;
  if (moving === "br" && entry.from.r === 0 && entry.from.c === 0) nextCastling.bQ = false;
  if (moving === "br" && entry.from.r === 0 && entry.from.c === 7) nextCastling.bK = false;

  if (target === "wr" && entry.to.r === 7 && entry.to.c === 0) nextCastling.wQ = false;
  if (target === "wr" && entry.to.r === 7 && entry.to.c === 7) nextCastling.wK = false;
  if (target === "br" && entry.to.r === 0 && entry.to.c === 0) nextCastling.bQ = false;
  if (target === "br" && entry.to.r === 0 && entry.to.c === 7) nextCastling.bK = false;

  if (moving && moving[1] === "p" && entry.to.doublePawn) {
    const dir = moving[0] === "w" ? -1 : 1;
    nextEnPassant = { r: entry.from.r + dir, c: entry.from.c };
  }

  return {
    board: nextBoard,
    turn: enemyOf(state.turn),
    castling: nextCastling,
    enPassant: nextEnPassant
  };
}

function pieceSquareBonus(piece, r, c) {
  if (!piece) return 0;
  const color = piece[0];
  const type = piece[1];
  const rr = color === "w" ? 7 - r : r;
  const centerDist = Math.abs(3.5 - c) + Math.abs(3.5 - rr);
  if (type === "p") return (6 - rr) * 0.05 - centerDist * 0.02;
  if (type === "n" || type === "b") return 0.2 - centerDist * 0.04;
  if (type === "r") return (rr > 0 && rr < 7 ? 0.08 : 0) - centerDist * 0.01;
  if (type === "q") return -centerDist * 0.015;
  if (type === "k") return rr <= 1 ? 0.12 : -centerDist * 0.03;
  return 0;
}

function stateToKey(state) {
  const rows = [];
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    let row = "";
    for (let c = 0; c < 8; c++) {
      const piece = state.board[r][c];
      if (!piece) {
        empty++;
      } else {
        if (empty) {
          row += String(empty);
          empty = 0;
        }
        row += fenPiece(piece);
      }
    }
    if (empty) row += String(empty);
    rows.push(row);
  }
  let castle = "";
  if (state.castling.wK) castle += "K";
  if (state.castling.wQ) castle += "Q";
  if (state.castling.bK) castle += "k";
  if (state.castling.bQ) castle += "q";
  if (!castle) castle = "-";
  const ep = state.enPassant ? toAlgebraic(state.enPassant.r, state.enPassant.c) : "-";
  return `${rows.join("/")} ${state.turn} ${castle} ${ep}`;
}

function moveSignature(entry) {
  const from = toAlgebraic(entry.from.r, entry.from.c);
  const to = toAlgebraic(entry.to.r, entry.to.c);
  const promo = entry.to.promotion || "";
  return `${from}${to}${promo}`;
}

function scoreMoveForOrdering(state, entry, perspectiveColor, ttBestSignature = null) {
  const moving = state.board[entry.from.r][entry.from.c];
  if (!moving) return -9999;
  const target = state.board[entry.to.r][entry.to.c];
  let score = 0;
  if (ttBestSignature && moveSignature(entry) === ttBestSignature) score += 2500;
  if (target) score += pieceValue(target) * 10 - pieceValue(moving) * 0.5;
  if (entry.to.enPassant) score += 8;
  if (entry.to.castle) score += 2;
  if (moving[1] === "p" && (entry.to.r === 0 || entry.to.r === 7)) score += 9;
  if (entry.to.r >= 2 && entry.to.r <= 5 && entry.to.c >= 2 && entry.to.c <= 5) score += 0.6;
  if (moving[1] === "k" && entry.to.castle) score += 4;
  return score;
}

function evaluateBoardState(state, perspectiveColor) {
  let score = 0;
  let myBishops = 0;
  let oppBishops = 0;
  let myPawns = 0;
  let oppPawns = 0;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = state.board[r][c];
      if (!piece) continue;
      const sign = piece[0] === perspectiveColor ? 1 : -1;
      score += sign * pieceValue(piece);
      score += sign * pieceSquareBonus(piece, r, c);
      if (piece[1] === "b") {
        if (sign > 0) myBishops++;
        else oppBishops++;
      }
      if (piece[1] === "p") {
        if (sign > 0) myPawns++;
        else oppPawns++;
      }
    }
  }
  if (myBishops >= 2) score += 0.35;
  if (oppBishops >= 2) score -= 0.35;
  score += (myPawns - oppPawns) * 0.03;
  return score;
}

function captureMovesOnly(state, color) {
  const all = allLegalMovesState(state, color);
  return all.filter((entry) => {
    const target = state.board[entry.to.r][entry.to.c];
    const moving = state.board[entry.from.r][entry.from.c];
    if (!moving) return false;
    const isPromotion = moving[1] === "p" && (entry.to.r === 0 || entry.to.r === 7);
    return !!target || !!entry.to.enPassant || isPromotion;
  });
}

function orderedMoves(state, moves, perspectiveColor, ttBestSignature = null) {
  const scored = moves.map((mv) => ({
    mv,
    s: scoreMoveForOrdering(state, mv, perspectiveColor, ttBestSignature)
  }));
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.mv);
}

function quiescence(state, alpha, beta, perspectiveColor, deadline, tt, ply) {
  if (Date.now() >= deadline) return evaluateBoardState(state, perspectiveColor);
  const sideToMove = state.turn;
  const maximizingNow = sideToMove === perspectiveColor;
  const standPat = evaluateBoardState(state, perspectiveColor);

  if (maximizingNow) {
    if (standPat >= beta) return standPat;
    if (standPat > alpha) alpha = standPat;
  } else {
    if (standPat <= alpha) return standPat;
    if (standPat < beta) beta = standPat;
  }

  if (ply >= 6) return standPat;

  const key = `${stateToKey(state)} q`;
  const cached = tt.get(key);
  const ttBestSignature = cached?.best || null;
  const caps = orderedMoves(state, captureMovesOnly(state, sideToMove), perspectiveColor, ttBestSignature);
  if (!caps.length) return standPat;

  let bestMoveSig = null;
  let best = maximizingNow ? -Infinity : Infinity;
  const alphaOrig = alpha;
  const betaOrig = beta;
  for (const mv of caps) {
    if (Date.now() >= deadline) break;
    const child = applyMoveToState(state, mv);
    const val = quiescence(child, alpha, beta, perspectiveColor, deadline, tt, ply + 1);
    const sig = moveSignature(mv);
    if (maximizingNow) {
      if (val > best) {
        best = val;
        bestMoveSig = sig;
      }
      alpha = Math.max(alpha, best);
    } else {
      if (val < best) {
        best = val;
        bestMoveSig = sig;
      }
      beta = Math.min(beta, best);
    }
    if (beta <= alpha) break;
  }

  if (!Number.isFinite(best)) return standPat;
  let flag = "exact";
  if (best <= alphaOrig) flag = "upper";
  else if (best >= betaOrig) flag = "lower";
  tt.set(key, { depth: 0, score: best, flag, best: bestMoveSig });
  return best;
}

function minimax(state, depth, alpha, beta, perspectiveColor, deadline, tt) {
  if (Date.now() >= deadline) {
    return evaluateBoardState(state, perspectiveColor);
  }
  const key = stateToKey(state);
  const cached = tt.get(key);
  if (cached && cached.depth >= depth) {
    if (cached.flag === "exact") return cached.score;
    if (cached.flag === "lower") alpha = Math.max(alpha, cached.score);
    else if (cached.flag === "upper") beta = Math.min(beta, cached.score);
    if (alpha >= beta) return cached.score;
  }

  const sideToMove = state.turn;
  const maximizingNow = sideToMove === perspectiveColor;
  const moves = allLegalMovesState(state, sideToMove);
  if (!moves.length) {
    const inCheckNow = withState({ ...state, turn: sideToMove }, () => isInCheck(state.board, sideToMove));
    const terminal = inCheckNow ? (maximizingNow ? -100000 - depth : 100000 + depth) : 0;
    tt.set(key, { depth, score: terminal, flag: "exact", best: null });
    return terminal;
  }
  if (depth <= 0) {
    const evalScore = quiescence(state, alpha, beta, perspectiveColor, deadline, tt, 0);
    tt.set(key, { depth, score: evalScore, flag: "exact", best: null });
    return evalScore;
  }
  const ttBestSignature = cached?.best || null;
  const ordered = orderedMoves(state, moves, perspectiveColor, ttBestSignature);
  const alphaOrig = alpha;
  const betaOrig = beta;
  let bestMoveSig = null;

  if (maximizingNow) {
    let best = -Infinity;
    for (const mv of ordered) {
      const child = applyMoveToState({ ...state, turn: sideToMove }, mv);
      const val = minimax(child, depth - 1, alpha, beta, perspectiveColor, deadline, tt);
      if (val > best) {
        best = val;
        bestMoveSig = moveSignature(mv);
      }
      alpha = Math.max(alpha, best);
      if (beta <= alpha || Date.now() >= deadline) break;
    }
    let flag = "exact";
    if (best <= alphaOrig) flag = "upper";
    else if (best >= betaOrig) flag = "lower";
    tt.set(key, { depth, score: best, flag, best: bestMoveSig });
    return best;
  }

  let best = Infinity;
  for (const mv of ordered) {
    const child = applyMoveToState({ ...state, turn: sideToMove }, mv);
    const val = minimax(child, depth - 1, alpha, beta, perspectiveColor, deadline, tt);
    if (val < best) {
      best = val;
      bestMoveSig = moveSignature(mv);
    }
    beta = Math.min(beta, best);
    if (beta <= alpha || Date.now() >= deadline) break;
  }
  let flag = "exact";
  if (best <= alphaOrig) flag = "upper";
  else if (best >= betaOrig) flag = "lower";
  tt.set(key, { depth, score: best, flag, best: bestMoveSig });
  return best;
}

function chooseFallbackDepth() {
  if (computerElo >= 2600) return 8;
  if (computerElo >= 2200) return 7;
  if (computerElo >= 1800) return 6;
  return 4;
}

function fallbackTimeBudgetMs() {
  if (computerElo >= 2600) return 10000;
  if (computerElo >= 2200) return 8000;
  if (computerElo >= 1800) return 5000;
  return 2500;
}

function chooseComputerMove(moves) {
  if (!moves.length) return null;
  const maxDepth = chooseFallbackDepth();
  const rootState = stateFromCurrentBoard();
  const deadline = Date.now() + fallbackTimeBudgetMs();
  const tt = new Map();
  const openingMoves = orderedMoves(rootState, moves, computerColor, null);
  let rootMoves = openingMoves;
  let bestMove = moves[0];
  let bestScore = -Infinity;

  for (let depth = 1; depth <= maxDepth; depth++) {
    if (Date.now() >= deadline) break;
    let currentBestMove = bestMove;
    let currentBestScore = -Infinity;
    for (const mv of rootMoves) {
      if (Date.now() >= deadline) break;
      const child = applyMoveToState(rootState, mv);
      const val = minimax(child, depth - 1, -Infinity, Infinity, computerColor, deadline, tt);
      if (val > currentBestScore) {
        currentBestScore = val;
        currentBestMove = mv;
      }
    }
    if (Date.now() < deadline || currentBestScore > bestScore || depth === 1) {
      bestScore = currentBestScore;
      bestMove = currentBestMove;
      const sig = moveSignature(bestMove);
      rootMoves = orderedMoves(rootState, moves, computerColor, sig);
    }
  }

  return bestMove;
}

function makeFallbackComputerMove() {
  if (!isComputerTurn() || gameOver) return;
  const moves = allLegalMoves(board, computerColor);
  const picked = chooseComputerMove(moves);
  if (!picked) {
    aiThinking = false;
    return;
  }
  pendingFallbackMove = picked;
  if (aiTimer) clearTimeout(aiTimer);
  aiTimer = setTimeout(() => {
    aiTimer = null;
    const next = pendingFallbackMove;
    pendingFallbackMove = null;
    aiThinking = false;
    if (next && isComputerTurn()) movePiece(next.from, next.to);
  }, AI_MOVE_COMMIT_DELAY_MS);
}

function scheduleComputerMove() {
  if (!isComputerTurn() || aiThinking || gameOver) return;
  if (stockfishLoading) {
    setStatus("Loading Stockfish...");
    if (aiTimer) clearTimeout(aiTimer);
    aiTimer = setTimeout(() => {
      aiTimer = null;
      scheduleComputerMove();
    }, 120);
    return;
  }

  aiThinking = true;
  setStatus("Computer is thinking...");
  render();

  if (aiTimer) clearTimeout(aiTimer);
  aiTimer = setTimeout(() => {
    aiTimer = null;
    if (!isComputerTurn() || gameOver || !aiThinking) return;

    if (stockfish && stockfishReady) {
      awaitingBestMove = true;
      postStockfish("stop");
      postStockfish(`position fen ${boardToFen()}`);
      const moveTime = Math.max(450, Math.min(4500, Math.round(computerElo * 1.15)));
      postStockfish(`go movetime ${moveTime}`);
      return;
    }
    if (stockfishFailed) {
      if (!stockfishLoading && Date.now() >= stockfishRetryAfterMs) {
        stockfishRetryAfterMs = Date.now() + 12000;
        initStockfish();
      }
      setStatus("Stockfish unavailable, using backup AI.");
      render();
      makeFallbackComputerMove();
      return;
    }
    makeFallbackComputerMove();
  }, AI_THINK_START_DELAY_MS);
}

function render() {
  boardEl.innerHTML = "";
  turnEl.textContent = turn === "w" ? "White" : "Black";

  for (let vr = 0; vr < 8; vr++) {
    for (let vc = 0; vc < 8; vc++) {
      const { r, c } = displayRowCol(vr, vc);
      const rankLabel = orientation === "w" ? 8 - vr : vr + 1;
      const fileLabel = orientation === "w" ? String.fromCharCode(97 + vc) : String.fromCharCode(104 - vc);
      const square = document.createElement("button");
      square.className = `square ${(vr + vc) % 2 === 0 ? "light" : "dark"}`;
      square.type = "button";
      square.setAttribute("aria-label", `Square ${fileLabel}${rankLabel}`);

      const piece = board[r][c];
      if (piece) {
        square.classList.add("has-piece");
        const pieceEl = document.createElement("img");
        pieceEl.className = `piece piece-${piece[0]} piece-${piece}`;
        pieceEl.src = PIECE_IMG[piece];
        pieceEl.alt = piece;
        pieceEl.loading = "eager";
        pieceEl.decoding = "async";
        pieceEl.draggable = piece[0] === turn && !gameOver;
        pieceEl.addEventListener("dragstart", (event) => onDragStart(event, r, c));
        pieceEl.addEventListener("dragend", onDragEnd);
        pieceEl.addEventListener("error", () => {
          const fallback = document.createElement("span");
          fallback.className = pieceEl.className;
          fallback.textContent = PIECE_FALLBACK[piece];
          fallback.draggable = pieceEl.draggable;
          fallback.addEventListener("dragstart", (event) => onDragStart(event, r, c));
          fallback.addEventListener("dragend", onDragEnd);
          pieceEl.replaceWith(fallback);
        });
        square.appendChild(pieceEl);
      }

      if (vc === 0) {
        square.classList.add("coord-rank");
        square.dataset.rank = String(rankLabel);
      }
      if (vr === 7) {
        square.classList.add("coord-file");
        square.dataset.file = fileLabel;
      }

      if (selected && selected.r === r && selected.c === c) {
        square.classList.add("selected");
      }

      if (lastMove) {
        if (lastMove.from.r === r && lastMove.from.c === c) square.classList.add("last-from");
        if (lastMove.to.r === r && lastMove.to.c === c) square.classList.add("last-to");
      }

      const mv = isLegalTarget(r, c);
      if (mv) {
        square.classList.add(mv.capture ? "capture" : "legal");
      }

      square.addEventListener("click", () => onSquareClick(r, c));
      square.addEventListener("dragover", onDragOver);
      square.addEventListener("drop", (event) => onDrop(event, r, c));
      boardEl.appendChild(square);
    }
  }
}

newGameBtn.addEventListener("click", resetGame);
flipBoardBtn.addEventListener("click", () => {
  orientation = orientation === "w" ? "b" : "w";
  render();
});
if (vsComputerBtn) {
  vsComputerBtn.addEventListener("click", () => {
    if (aiTimer) {
      clearTimeout(aiTimer);
      aiTimer = null;
    }
    pendingFallbackMove = null;
    awaitingBestMove = false;
    if (stockfish) postStockfish("stop");
    aiThinking = false;
    vsComputer = !vsComputer;
    updateVsComputerButton();
    draggedFrom = null;
    selected = null;
    legalMoves = [];
    if (isComputerTurn()) {
      setStatus("Computer is thinking...");
      render();
      scheduleComputerMove();
    } else {
      setStatus(isInCheck(board, turn) ? "Check." : "Select a piece to move.");
      render();
    }
  });
}

if (computerRatingEl) {
  computerRatingEl.addEventListener("input", () => {
    computerElo = Number(computerRatingEl.value);
    updateRatingLabel();
    applyStockfishOptions();
  });
}

initStockfish();
resetGame();

