/**
 * Process entry point. Importing the config first means a bad environment fails
 * here, before a port is bound or a connection pool is opened.
 */
import './config/index.js';
import { startServer } from './server.js';

startServer();
