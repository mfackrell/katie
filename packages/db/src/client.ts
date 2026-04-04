import { Pool } from 'pg';

export const createDb = (databaseUrl: string) => new Pool({ connectionString: databaseUrl });

export type Db = ReturnType<typeof createDb>;
