import { RunnableConfig } from '@langchain/core/runnables';
import { State } from './state';

export type NodeFunction = (state: State, config?: RunnableConfig) => Promise<Partial<State>>;
