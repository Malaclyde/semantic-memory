import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'test.db');
const PORT = 3000;

function db(): Database.Database {
    if (!fs.existsSync(DB_PATH)) {
        console.error(`test.db not found at ${DB_PATH}`);
        console.error('Run the seed script first: npx tsx src/seed.ts');
        process.exit(1);
    }
    return new Database(DB_PATH);
}

function serveFile(res: http.ServerResponse, filePath: string, contentType: string) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
}

const MIME: Record<string, string> = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    // API routes
    if (pathname === '/api/graph') {
        const d = db();
        const chunks = d.prepare('SELECT id, text, outdated FROM chunks').all() as any[];
        const concepts = d.prepare('SELECT id, name, description FROM concepts').all() as any[];
        const edges = d.prepare('SELECT chunk_id, concept_id FROM edges').all() as any[];
        d.close();

        const nodes: any[] = [
            ...chunks.map(c => ({
                id: `chunk-${c.id}`, label: c.text.substring(0, 60),
                group: c.outdated ? 'chunk-outdated' : 'chunk',
                shape: 'box', title: `Chunk #${c.id}`,
                _type: 'chunk', _dbId: c.id, _outdated: !!c.outdated,
            })),
            ...concepts.map(c => ({
                id: `concept-${c.id}`, label: c.name,
                group: 'concept', shape: 'ellipse', title: `Concept #${c.id}`,
                _type: 'concept', _dbId: c.id,
            })),
        ];
        const graphEdges = edges.map(e => ({
            from: `chunk-${e.chunk_id}`, to: `concept-${e.concept_id}`,
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ nodes, edges: graphEdges }));
        return;
    }

    if (pathname.startsWith('/api/node/')) {
        const parts = pathname.split('/');
        const type = parts[3]; // 'chunk' or 'concept'
        const id = Number(parts[4]);

        if (!id) { res.writeHead(400); res.end('Bad request'); return; }

        const d = db();
        if (type === 'chunk') {
            const chunk = d.prepare('SELECT id, text, outdated FROM chunks WHERE id = ?').get(id) as any;
            if (!chunk) { d.close(); res.writeHead(404); res.end('Not found'); return; }
            const concepts = d.prepare(`
                SELECT c.id, c.name, c.description FROM concepts c
                JOIN edges e ON c.id = e.concept_id WHERE e.chunk_id = ?
            `).all(id) as any[];
            d.close();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...chunk, concepts, outdated: !!chunk.outdated }));
        } else if (type === 'concept') {
            const concept = d.prepare('SELECT id, name, description FROM concepts WHERE id = ?').get(id) as any;
            if (!concept) { d.close(); res.writeHead(404); res.end('Not found'); return; }
            const chunks = d.prepare(`
                SELECT c.id, c.text, c.outdated FROM chunks c
                JOIN edges e ON c.id = e.chunk_id WHERE e.concept_id = ?
            `).all(id) as any[];
            d.close();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ...concept, chunks }));
        } else {
            d.close();
            res.writeHead(400); res.end('Bad request');
        }
        return;
    }

    // Static files
    if (pathname === '/' || pathname === '') {
        serveFile(res, path.join(__dirname, 'index.html'), 'text/html');
    } else {
        const ext = path.extname(pathname);
        const filePath = path.join(__dirname, pathname);
        serveFile(res, filePath, MIME[ext] || 'application/octet-stream');
    }
});

server.listen(PORT, () => {
    console.log(`Graph viewer at http://localhost:${PORT}`);
});
