// SPDX-License-Identifier: MIT
import {
  NodeConnectionTypes,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow';
import { CREDENTIAL_NAME, PRODUCT_NAME } from '../shared/constants';
import { nodeError } from '../shared/errors';
import * as load from '../shared/loadOptions';
import { nodeProperties } from './descriptions';
import { runOperation, type RunCache } from './operations';

export class BinesOs implements INodeType {
  description: INodeTypeDescription = {
    displayName: PRODUCT_NAME,
    name: 'binesOs',
    icon: 'file:binesOs.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: `Work with ${PRODUCT_NAME} boards, items, subitems, templates, updates, files, time tracking and AI agents`,
    defaults: { name: PRODUCT_NAME },
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIAL_NAME, required: true }],
    properties: nodeProperties,
  };

  methods = {
    loadOptions: {
      getBoards: load.getBoards,
      getGroups: load.getGroups,
      getTargetGroups: load.getTargetGroups,
      getColumns: load.getColumns,
      getStatusColumns: load.getStatusColumns,
      getFileColumns: load.getFileColumns,
      getTimeColumns: load.getTimeColumns,
      getItemTemplates: load.getItemTemplates,
      getLabels: load.getLabels,
      getUsers: load.getUsers,
      getAgents: load.getAgents,
    },
    listSearch: {
      searchFindValues: load.searchFindValues,
      searchFilterValues: load.searchFilterValues,
    },
    resourceMapping: {
      getColumnFields: load.getColumnFields,
      getSubitemColumnFields: load.getSubitemColumnFields,
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    const cache: RunCache = { schemas: new Map() };
    for (let i = 0; i < items.length; i++) {
      try {
        const resource = this.getNodeParameter('resource', i) as string;
        const operation = this.getNodeParameter('operation', i) as string;
        const rows = await runOperation(this, cache, resource, operation, i);
        out.push(...rows.map((json) => ({ json, pairedItem: { item: i } })));
      } catch (error) {
        if (!this.continueOnFail()) throw nodeError(this.getNode(), error, i);
        out.push({ json: { error: (error as Error).message } as IDataObject, pairedItem: { item: i } });
      }
    }
    return [out];
  }
}
