export type ProjectGame={enginePath:string;rules:any;acceptance:any};
export function validateProjectGame(game:unknown,allowedPaths:string[],finalContract:unknown):ProjectGame;
export function validateGameRules(spec:unknown):unknown;
export function validateGameAcceptance(spec:unknown,acceptance:unknown):{contractReady:boolean};
export function runGameModelAcceptance(spec:unknown,acceptance:unknown,applyAction:(state:unknown,action:unknown)=>unknown):any;
