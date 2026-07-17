// This as annoying because CircleCI does not use the App API.
// Hence we must monitor statuses rather than using the more convenient
// "checks" API.
//
// After changing this file, use `ncc build index.js -o dist` to rebuild to dist/

// Refs:
// https://docs.github.com/en/developers/webhooks-and-events/webhooks/webhook-events-and-payloads#status

import * as core from '@actions/core'
import * as github from '@actions/github'
import fetch from 'node-fetch'

async function run() {
  try {
    core.debug((new Date()).toTimeString())
    const payload = github.context.payload
    const path = core.getInput('artifact-path', {required: true})
    const token = core.getInput('repo-token', {required: true})
    const apiToken = core.getInput('api-token', {required: false})
    const headers = {
      'accept': 'application/json',
      'user-agent': 'curl/7.85.0'
    }
    if (apiToken && apiToken !== '' && apiToken !== 'null') {
      headers['Circle-Token'] = apiToken
      core.debug(`CircleCI API token provided`)
    }

    /**
     * Helper to fetch from CircleCI API with automatic token fallback for public repos
     */
    const fetchCircleCI = async (url) => {
      let res = await fetch(url, {headers});
      let data = await res.json();

      if (data.message === 'Invalid token provided.' && headers['Circle-Token']) {
        core.debug(`Token rejected for ${url}, attempting unauthenticated request...`);
        // Permanently remove the token from future requests in this run
        delete headers['Circle-Token'];
        res = await fetch(url, {headers});
        data = await res.json();
      }

      if (data.message) {
        throw new Error(`CircleCI API error: ${data.message}`);
      }
      return data;
    };

    var circleciJobs = core.getInput('circleci-jobs', {required: false})
    if (circleciJobs === '') {
      circleciJobs = 'build_docs,doc,build'
    }

    // Split circleJobs into an array of job names
    const circleciJobNames = circleciJobs.split(',')

    //  Defines a variable to help prefix each job name with ci/circleci
    const prepender = x => `ci/circleci: ${x}`
    circleciJobs = circleciJobNames.map(prepender)
    core.debug(`Considering CircleCI jobs named: ${circleciJobs}`)

    if (circleciJobs.indexOf(payload.context) < 0) {
      core.debug(`Ignoring context: ${payload.context}`)
      return
    }

    // Read out 'state' (whether CircleCI process was successful or not), then
    //  store in debug output along with the target_url
    const state = payload.state
    core.debug(`context:    ${payload.context}`)
    core.debug(`state:      ${state}`)
    core.debug(`target_url: ${payload.target_url}`)
    // e.g., https://circleci.com/gh/mne-tools/mne-python/53315
    // e.g., https://circleci.com/gh/scientific-python/circleci-artifacts-redirector-action/94?utm_campaign=vcs-integration-link&utm_medium=referral&utm_source=github-build-link
    // Set the new status
    let url = '';
    let artifacts_url = '';
    const target = payload.target_url.split('?')[0].replace(/\/$/, '');   // strip any ?utm=… and trailing slashes
    if (target.includes('app.circleci.com') || target.includes('/pipelines/circleci/')) {
      // ───── New GitHub‑App URL ───────────────────────────────────────────
      // .../pipelines/circleci/<org‑id>/<project‑id>/<pipe‑seq>/workflows/<workflow‑id>
      // OR
      // .../workflow/<workflow-id>
      // OR
      // .../workflow/<workflow-id>/job/<job-id>

      const parts = target.split('/');
      const jIdx = parts.findIndex(p => p === 'job');
      const wIdx = parts.findIndex(p => p.startsWith('workflow'));

      if (jIdx !== -1 && parts.length > jIdx + 1) {
        // If we have a Job ID (UUID) in the URL, we can construct the artifact URL directly
        // and avoid calling the restricted /jobs/{id} API endpoint.
        const jobId = parts[jIdx + 1];
        core.debug(`Job ID detected: ${jobId}`);
        url = `https://output.circle-artifacts.com/output/job/${jobId}/artifacts/${path}`;
        core.debug(`Constructed artifact URL directly from Job ID: ${url}`);
      } else {
        const workflowId = (wIdx !== -1 && parts.length > wIdx + 1) ? parts[wIdx + 1] : parts.pop();
        core.debug(`Workflow ID detected: ${workflowId}`);

        // 1. Get the jobs that belong to this workflow
        const jobs = await fetchCircleCI(`https://circleci.com/api/v2/workflow/${workflowId}/job`);

        if (!jobs.items || !jobs.items.length) {
          core.setFailed(`No jobs returned for workflow ${workflowId}`);
          return;
        }

        // 2. Identify and select the relevant job
        let selectedJob = null;
        // If there are multiple jobs in the workflow, select the first one that
        // matches one of the job names passed to the action.
        for (const jobItem of jobs.items) {
          core.debug(`Checking job: ${jobItem.name} against ${circleciJobNames.join(',')}`);
          if (circleciJobNames.includes(jobItem.name)) {
            selectedJob = jobItem;
            break;
          }
        }

        // In the case where no matching job is found, or there's only one job,
        // fall back to the first job in the list.
        if (selectedJob == null) {
          selectedJob = jobs.items[0];
          if (jobs.items.length > 1) {
            core.debug(`No matching job found for ${circleciJobNames.join(', ')}. Using first job: ${selectedJob.name}`);
          } else {
            core.debug("Workflow contains only one job.");
          }
        }

        // Extract the project slug and job number from the selected job
        const projectSlug = selectedJob.project_slug;  // "circleci/<org‑id>/<project‑id>"
        const jobNumber   = selectedJob.job_number;

        core.debug(`slug:  ${projectSlug}`);
        core.debug(`job#:  ${jobNumber}`);

        // 3. Construct the v2 artifacts endpoint
        artifacts_url = `https://circleci.com/api/v2/project/${projectSlug}/${jobNumber}/artifacts`;
      }
    } else {
      // ───── Legacy OAuth URL (…/gh/<org>/<repo>/<build>) ────────────────
      const parts    = target.split('/');
      const orgId    = parts.slice(-3)[0];
      const repoId   = parts.slice(-2)[0];
      const buildId  = parts.slice(-1)[0];

      artifacts_url =
        `https://circleci.com/api/v2/project/gh/${orgId}/${repoId}/${buildId}/artifacts`;
    }
    if (url === '') {
      core.debug(`Fetching JSON: ${artifacts_url}`)
      // e.g., https://circleci.com/api/v2/project/gh/scientific-python/circleci-artifacts-redirector-action/94/artifacts
      const artifacts = await fetchCircleCI(artifacts_url);

      core.debug(`Artifacts JSON:`)
      core.debug(JSON.stringify(artifacts))
      // e.g., {"next_page_token":null,"items":[{"path":"test_artifacts/root_artifact.md","node_index":0,"url":"https://output.circle-artifacts.com/output/job/6fdfd148-31da-4a30-8e89-a20595696ca5/artifacts/0/test_artifacts/root_artifact.md"}]}
      if (artifacts.items && artifacts.items.length > 0) {
        url = `${artifacts.items[0].url.split('/artifacts/')[0]}/artifacts/${path}`
      }
      else {
        url = payload.target_url;
      }
    }
    // Set root domain
    var domain = core.getInput('domain')
    url = `https://${domain}/output/${url.split('/output/')[1]}`
    core.debug(`Linking to: ${url}`)
    core.debug((new Date()).toTimeString())
    core.setOutput("url", url)
    const client = github.getOctokit(token)
    var description = '';
    if (payload.state === 'pending') {
      description = 'Waiting for CircleCI ...'
    }
    else {
      description = `Link to ${path}`
    }
    var job_title = core.getInput('job-title', {required: false})
    if (job_title === '') {
      job_title = `${payload.context} artifact`
    }
    return client.rest.repos.createCommitStatus({
      repo: github.context.repo.repo,
      owner: github.context.repo.owner,
      sha: payload.sha,
      state: state,
      target_url: url,
      description: description,
      context: job_title
    })
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()
