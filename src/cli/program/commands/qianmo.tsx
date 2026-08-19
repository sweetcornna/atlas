// Registered so the Qianmo subcommands appear in `occ --help` (P11.5). The
// actual dispatch is intercepted by the fast-path in cli.tsx before
// Commander.js runs (same arrangement as `migrate` / `remote-control`), so
// these actions are normally unreachable and exist only as a help surface
// and a fallback if the fast path is ever bypassed. Options are deliberately
// not replicated here — each handler parses process.argv itself.
import type { Command as CommanderCommand } from '@commander-js/extra-typings';

export function registerQianmoCommands(program: CommanderCommand): void {
  program
    .command('resident')
    .description('Run a Qianmo resident agent node')
    .action(async () => {
      const { runResident } = await import('src/cli/handlers/resident.js');
      await runResident(process.argv.slice(3));
    });

  program
    .command('audit')
    .description('Inspect the Qianmo audit trail')
    .action(async () => {
      const { runQianmoAudit } = await import('src/cli/handlers/qianmoAudit.js');
      runQianmoAudit(process.argv.slice(3));
    });

  program
    .command('resident-wake')
    .description('Wake a resident agent on another node')
    .action(async () => {
      const { runResidentWake } = await import('src/cli/handlers/residentWake.js');
      await runResidentWake(process.argv.slice(3));
    });

  program
    .command('console')
    .description('Serve the Qianmo web console')
    .action(async () => {
      const { runConsole } = await import('src/cli/handlers/console.js');
      await runConsole(process.argv.slice(3));
    });

  program
    .command('watch')
    .description('Run the hub-side watch-job scheduler')
    .action(async () => {
      const { runWatch } = await import('src/cli/handlers/watch.js');
      await runWatch(process.argv.slice(3));
    });
}
