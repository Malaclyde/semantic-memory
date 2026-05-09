import Embedder from "./kb/embedder";
import DB, { Concept } from './kb/db';
import Reranker from "./kb/reranker";

// const EMBEDDING_MODEL = 'microsoft/harrier-oss-v1-27b'
const EMBEDDING_MODEL = {name: 'Xenova/all-MiniLM-L6-v2', numDimensions:  384}
const RERANKER_TOKENIZER = 'Xenova/bge-reranker-base';
const RERANKER_MODEL = 'Xenova/bge-reranker-base';
//const EMBEDDING_MODEL = {name: 'Xenova/nomic-embed-text-v1.5', numDimensions:  768}
const e = new Embedder(EMBEDDING_MODEL.name, EMBEDDING_MODEL.numDimensions);
const r = new Reranker(RERANKER_TOKENIZER, RERANKER_MODEL);
const db = new DB(e, r);

// db.insertChunk(
//     "Austrian legal framework for DevOps freelancers: Option 1 - Neue Selbständige (freelancers) - suitable for consulting, creative, technical fields. No Gewerbe required, but must register with Finanzamt. Option 2 - Gewerbeanmeldung - required for commercial activities. Online registration at USP.gv.at, costs €35-150. WKO membership mandatory. Betriebseröffnung to Finanzamt within 1 month. Kleinunternehmerregelung 2025: VAT exemption threshold increased to €55,000. Income tax threshold: €13,308. SVS minimum: €551/month for first 3 years. Sources: thetax.at, expatica.com, remote.com, austriaczech.com",
//     [
//         {name: "freelancer legal framework", description: "Austrian legal framework for DevOps freelancers"},
//         {name: "Neue Selbständige", description: "freelancers in Austria"},
//         {name: "Gewerbe"},
//         {name: "Finanzamt"},
//         {name: "Kleinunternehmerregelung"}
//     ]
// )

// db.insertChunk(
//     "Austrian legal framework for DevOps freelancers: Option 1 - Neue Selbständige (freelancers) - suitable for consulting, creative, technical fields. No Gewerbe required, but must register with Finanzamt.",
//     [
//     ]
// )

// db.insertChunk("Option 2 - Gewerbeanmeldung - required for commercial activities. Online registration at USP.gv.at, costs €35-150. WKO membership mandatory. Betriebseröffnung to Finanzamt within 1 month. Kleinunternehmerregelung 2025: VAT exemption threshold increased to €55,000. Income tax threshold: €13,308. SVS minimum: €551/month for first 3 years. Sources: thetax.at, expatica.com, remote.com, austriaczech.com", []);

// //e.embed("This is a gift, it comes with a prize").then(data => console.log(data));

//db.semanticSearch("Gewerbeanmeldung", 3);

// async function test(database: DB, embedder: Embedder) {
//     const embedding = await embedder.embed("How to register for freelance work in Austria?"); 

//     // const res = database.db.prepare(`
//     //     SELECT id, distance
//     //     FROM vec_chunks
//     //     WHERE embedding MATCH ?
//     //     ORDER BY distance
//     //     LIMIT ?
//     // `).all(JSON.stringify(Array.from(embedding)), 10)
//     const res = database.db.prepare(`
//         SELECT vc.id, c.text, distance
//         FROM vec_chunks as vc
//         JOIN chunks as c on vc.id = c.id
//         WHERE embedding MATCH ? AND k = ?
//         ORDER BY distance
//     `).all(JSON.stringify(Array.from(embedding)), 10)
//     console.log(res)
// }

// db.semanticSearch("How to register for freelance work in Austria?", 3)

db.combinedSearch("How to implement adaptive search", 5).then(result => console.log(result));
