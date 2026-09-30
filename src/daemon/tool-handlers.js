import { launchKiaraProfile, navigateToFlow } from '../browser/launch-profile.js';
import { getPage, setBrowser, closeBrowser as closeBrowserConnection } from '../browser/connect.js';
import { verifyAccount as checkAccount } from '../browser/account-check.js';
import { handleFlowStatus } from '../tools/flow-status.js';
import path from 'node:path';
import { legacyModel, parseDuration } from '../flow/ui.js';
import { WIRE_MODELS } from './models.js';
import { validateJobRequest } from './validate.js';
import { handleDownloadLatest } from '../tools/download-latest.js';
import { handleCreateCharacter } from '../tools/create-character.js';
import { handleImportCharacter } from '../tools/import-character.js';
import { handleOpenCharacters } from '../tools/open-characters.js';
import { handleCreateScene } from '../tools/create-scene.js';
import { handleOpenToolsGallery } from '../tools/open-tools-gallery.js';
import { handleUseGridArchitect } from '../tools/grid-architect.js';
import { handleDiscoverUi } from '../tools/discover-ui.js';
import { handleUseFlowTool } from '../tools/use-flow-tool.js';
import { jobQueue } from '../queue/job-queue.js';
import { takeScreenshot } from '../utils/screenshots.js';
import { logger } from '../utils/logger.js';
import { DaemonError, JobErrorCodes } from './errors.js';

// MCP entry to the same pipeline the daemon jobs use. auto_confirm !== true never touches Flow.
async function generateForTool(kind, args, options) {
  const model = legacyModel(kind, args?.model);
  const aspectRatio = args?.ratio ?? (kind === 'image' ? '1:1' : '16:9');
  const duration = kind === 'video' ? parseDuration(args?.duration) : undefined;
  // Same checks as POST /jobs, so an unsupported ratio never reaches the settings panel.
  validateJobRequest({ kind, model, prompt: args?.prompt, aspectRatio, duration, idempotencyKey: 'mcp-tool-call' });
  if (args?.auto_confirm !== true) {
    return { status: 'ready_for_confirmation', type: kind, model_used: WIRE_MODELS[model].flowName, ratio: aspectRatio, duration,
      message: 'Nothing was sent to Flow. Call again with auto_confirm=true to generate; this may spend Flow credits.' };
  }
  const job = {
    kind, model, flowModel: WIRE_MODELS[model].flowName, prompt: args.prompt, aspectRatio, duration,
    project: args.project_name ?? args.campaign,
    outputDir: args.output_folder ?? path.join(options.outputsDir, 'mcp', new Date().toISOString().replace(/[:.]/gu, '-')),
    inputs: { references: kind === 'image' ? (args.reference_images ?? []) : [], ingredients: kind === 'video' ? (args.reference_images ?? []) : [] },
  };
  const media = kind === 'image' ? await options.driver.generateImage(job, () => {}) : await options.driver.generateVideo(job, () => {});
  return { status: 'success', type: kind, model_used: job.flowModel, ratio: aspectRatio, duration, prompt: args.prompt,
    files: media.map((item) => item.file), credits_consumed: true };
}

export async function callTool(name, args, options) {
  logger.info('Tool called', { tool: name, args: args ? JSON.stringify(args).substring(0, 200) : 'none' });
  switch (name) {
    case 'flow_connect': {
      const result = await launchKiaraProfile(args?.headless || false);
      if (result.browser) setBrowser(result.browser);
      const page = getPage();
      let oauthRequired = false;
      if (args?.open_flow !== false) {
        const navResult = await navigateToFlow(page);
        if (navResult && navResult.authenticated === false) {
          oauthRequired = true;
        }
      }
      let accountCheck = null;
      try {
        accountCheck = await checkAccount(page);
      } catch (e) {
        accountCheck = { verified: false, error: e.message };
      }
      if (oauthRequired) {
        return {
          status: 'oauth_required',
          message: 'Google Flow richiede login manuale una tantum:\n'
            + '  1. Esegui scripts/ensure-flow-chrome.ps1 (apre Chrome sul profilo dedicato)\n'
            + '  2. Completa il login Google in quella finestra\n'
            + '  3. Rilancia flow_connect',
          browserType: 'Chrome dedicato (FlowAutomationChrome)',
          account: accountCheck?.account || 'verified-account',
          url: page.url().substring(0, 100),
          accountVerified: accountCheck,
        };
      }
      return {
        status: 'connected',
        browserType: 'Chrome dedicato (FlowAutomationChrome)',
        account: accountCheck?.account || 'verified-account',
        url: page.url(),
        accountVerified: accountCheck,
      };
    }
    case 'flow_disconnect':
      await closeBrowserConnection();
      return { status: 'disconnected' };
    case 'flow_status': return handleFlowStatus();
    case 'flow_account_check': return checkAccount(getPage());
    case 'flow_discover_ui': return handleDiscoverUi(args);
    case 'flow_generate_image': return generateForTool('image', args, options);
    case 'flow_generate_video': return generateForTool('video', args, options);
    case 'flow_download_latest': return handleDownloadLatest(args);
    case 'flow_create_character': return handleCreateCharacter(args);
    case 'flow_import_character': return handleImportCharacter(args);
    case 'flow_open_characters': return handleOpenCharacters(args);
    case 'flow_create_scene': return handleCreateScene(args);
    case 'flow_open_tools_gallery': return handleOpenToolsGallery(args);
    case 'flow_use_grid_architect': return handleUseGridArchitect(args);
    case 'flow_use_tool': return handleUseFlowTool(args);
    case 'flow_screenshot': {
      const screenshot = await takeScreenshot(getPage(), args?.name || 'manual');
      return { screenshot, message: 'Screenshot saved.' };
    }
    case 'flow_queue_status':
      return { daemon: options.runnerStatus(), legacy: jobQueue.getStatus(args?.history_limit) };
    default:
      throw new DaemonError(JobErrorCodes.NOT_FOUND, `Unknown tool: ${name}`);
  }
}
