// Read-only mission capabilities supported by the existing, saved agent team.
// A domain label does not confer repo access, deployment, external systems, or
// tools. Unknown/privileged capabilities require separately reviewed building.
export type CatalogAgent={config:{name?:string;research?:boolean;development?:boolean}};
export function verifiedMissionCatalog(agents:CatalogAgent[]):string[]{
 const names=new Map(agents.map(a=>[a.config.name,a.config]));
 const lead=names.get('Mission Lead');
 const analyst=names.get('Analysis Agent')??names.get('Project Lead');
 const researcher=names.get('Research Agent')??names.get('Project Research');
 // Only advertise contracts that the available general-purpose calculator,
 // analysis, public-web research and composition tools can actually fulfill.
 // Independent mission acceptance is still mandatory before activation.
 if(!lead||!analyst||!researcher?.research)return [];
 return ['financial_analysis','operations_analysis','research_synthesis'];
}
