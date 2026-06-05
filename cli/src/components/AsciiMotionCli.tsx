import React, { useEffect } from 'react';
import { Box, Text, useInput } from 'ink';

export type PlaybackAPI = {
	play: () => void;
	pause: () => void;
	restart: () => void;
};

export type AsciiMotionCliProps = {
	hasDarkBackground?: boolean;
	onInteraction?: (input: string, key: any) => void;
	autoPlay?: boolean;
	loop?: boolean;
	onReady?: (api: PlaybackAPI) => void;
};

// ISAAC — Intelligence Souveraine Ailiance Agent Codeur.
// 3D extruded block wordmark: a lit cyan front face with an offset
// dark-cyan extrusion (down-right) for depth, rendered as per-character
// coloured spans so the two faces read as a real 3D solid.
const ISAAC_FRONT = '#22D3EE';   // cyan — lit front face
const ISAAC_DEPTH = '#0E7490';   // dark cyan — extruded side (the 3D body)
const ISAAC_TAGLINE_COLOR = '#52525B';
const ISAAC_TAGLINE = 'Intelligence Souveraine Ailiance Agent Codeur';

// Flat bitmap, '#' = filled pixel. Letters I S A A C.
const ISAAC_BITMAP = [
	'#####  #####   ###    ###   #####',
	'  #    #      #   #  #   #  #    ',
	'  #    #####  #   #  #   #  #    ',
	'  #        #  #####  #####  #    ',
	'  #        #  #   #  #   #  #    ',
	'#####  #####  #   #  #   #  #####',
];

// Extrusion offset (down-right) that produces the 3D pop.
const DX = 1;
const DY = 1;

type Cell = 'F' | 'S' | ' '; // Front face / Shadow (extruded side) / empty

function buildIsaac3D(): Cell[][] {
	const w = Math.max(...ISAAC_BITMAP.map((r) => r.length));
	const bmp = ISAAC_BITMAP.map((r) => r.padEnd(w, ' '));
	const h = bmp.length;
	const grid: Cell[][] = [];
	for (let r = 0; r < h + DY; r++) {
		const row: Cell[] = [];
		for (let c = 0; c < w + DX; c++) {
			const front = r < h && c < w && bmp[r][c] === '#';
			const sr = r - DY;
			const sc = c - DX;
			const shadow = sr >= 0 && sc >= 0 && sr < h && sc < w && bmp[sr][sc] === '#';
			row.push(front ? 'F' : shadow ? 'S' : ' ');
		}
		grid.push(row);
	}
	return grid;
}

const ISAAC_GRID = buildIsaac3D();
const GRID_WIDTH = ISAAC_GRID[0].length;

// Coalesce a row of cells into same-styled runs (fewer Ink spans).
function rowRuns(cells: Cell[]): { text: string; cell: Cell }[] {
	const runs: { text: string; cell: Cell }[] = [];
	for (const cell of cells) {
		const glyph = cell === ' ' ? ' ' : '█';
		const last = runs[runs.length - 1];
		if (last && last.cell === cell) last.text += glyph;
		else runs.push({ text: glyph, cell });
	}
	return runs;
}

function padFor(contentWidth: number): string {
	const width = process.stdout.columns || 80;
	return ' '.repeat(Math.max(0, Math.floor((width - contentWidth) / 2)));
}

export const StaticRobotFrame: React.FC<{ hasDarkBackground?: boolean }> = () => {
	const pad = padFor(GRID_WIDTH);
	const tagPad = padFor(ISAAC_TAGLINE.length);
	return (
		<Box flexDirection="column" marginBottom={1} marginTop={1}>
			{ISAAC_GRID.map((cells, idx) => (
				<Text key={idx}>
					{pad}
					{rowRuns(cells).map((run, i) =>
						run.cell === ' ' ? (
							<Text key={i}>{run.text}</Text>
						) : (
							<Text key={i} bold={run.cell === 'F'} color={run.cell === 'F' ? ISAAC_FRONT : ISAAC_DEPTH}>
								{run.text}
							</Text>
						),
					)}
				</Text>
			))}
			<Text color={ISAAC_TAGLINE_COLOR}>
				{tagPad}
				{ISAAC_TAGLINE}
			</Text>
		</Box>
	);
};

/**
 * AsciiMotionCli - Now a static version of the Isaac logo.
 * Maintained for compatibility with existing views, but with all animation logic removed.
 */
export const AsciiMotionCli: React.FC<AsciiMotionCliProps> = ({ onReady, onInteraction }) => {
	useEffect(() => {
		if (onReady) {
			onReady({
				play: () => {},
				pause: () => {},
				restart: () => {},
			});
		}
	}, [onReady]);

	// Trigger onInteraction to allow dismissing the welcome state via any keypress
	useInput((input, key) => {
		if (onInteraction) {
			onInteraction(input, key);
		}
	});

	return <StaticRobotFrame />;
};
