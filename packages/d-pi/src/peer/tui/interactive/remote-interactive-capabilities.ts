export interface RemoteInteractiveCapabilities {
	supportsCompact: boolean;
	supportsReload: boolean;
	supportsModelSelection: boolean;
	supportsAgentSwitching?: boolean;
	supportsSettings?: boolean;
	supportsGroup?: boolean;
	supportsSessionDetails?: boolean;
	supportsSources?: boolean;
	supportsMcp?: boolean;
	supportsSkills?: boolean;
	supportsSessionTree: boolean;
	supportsSessionCreation: boolean;
	supportsSessionResume: boolean;
	supportsSessionFork: boolean;
	supportsSessionClone: boolean;
}
