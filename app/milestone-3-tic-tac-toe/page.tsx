'use client';

import { useState } from 'react';
import { createInitialGameState, playMove } from '@/lib/milestone-3-tic-tac-toe/game';

export default function Milestone3TicTacToePage() {
  const [gameState, setGameState] = useState(createInitialGameState);

  return (
    <main style={{ display: 'grid', gap: '1rem', justifyItems: 'start', padding: '1rem' }}>
      <h1>Tic-Tac-Toe</h1>

      <p id="status" aria-live="polite">
        {gameState.status}
      </p>

      <div
        id="board"
        role="grid"
        aria-label="Tic-tac-toe board"
        style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 64px)', gap: '0.5rem' }}
      >
        {gameState.board.map((cell, index) => (
          <button
            key={index}
            type="button"
            data-cell={index}
            aria-label={`Cell ${index}`}
            onClick={() => setGameState((currentState) => playMove(currentState, index))}
            style={{ width: 64, height: 64, fontSize: '2rem', lineHeight: 1 }}
          >
            {cell}
          </button>
        ))}
      </div>

      <button id="new-game" type="button" onClick={() => setGameState(createInitialGameState())}>
        New Game
      </button>
    </main>
  );
}
