// OmniMap — Express Entry Point
// Configures middleware, mounts routes, and starts the HTTP server.

import * as path    from 'path';
import * as dotenv  from 'dotenv';

dotenv.config({ path: path.join(__dirname, '..', '.env') });

import express, { Request, Response, NextFunction } from 'express';
import { authenticate }  from './middleware/auth';
import projectsRouter       from './routes/projects';
import reviewerRouter       from './routes/reviewer';
import terminologiesRouter  from './routes/terminologies';
import adjudicatorRouter       from './routes/adjudicator';
import auditRouter             from './routes/audit';
import searchRouter            from './routes/search';
import qualifierPatternsRouter from './routes/qualifierPatterns';
import usersRouter             from './routes/users';

const app  = express();
const PORT = parseInt(process.env.PORT ?? '3001', 10);

// -----------------------------------------------------------------
// Global middleware
// -----------------------------------------------------------------

app.use(express.json({ limit: '10mb' }));

// Auth — applies to all /api routes
app.use('/api', authenticate);

// -----------------------------------------------------------------
// Routes
// -----------------------------------------------------------------

app.use('/api/projects',       projectsRouter);
app.use('/api/reviewer',      reviewerRouter);
app.use('/api/terminologies', terminologiesRouter);
app.use('/api/adjudicator',   adjudicatorRouter);
app.use('/api/audit',               auditRouter);
app.use('/api/search',              searchRouter);
app.use('/api/qualifier-patterns',  qualifierPatternsRouter);
app.use('/api/users',               usersRouter);

// Health check (unauthenticated)
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// -----------------------------------------------------------------
// Error handler
// -----------------------------------------------------------------

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[Error]', err.message);
  if (process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }
  res.status(500).json({ error: err.message });
});

// -----------------------------------------------------------------
// Start
// -----------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[OmniMap] API listening on port ${PORT}`);
});

export default app;
