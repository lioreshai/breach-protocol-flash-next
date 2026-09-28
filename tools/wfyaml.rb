#!/usr/bin/env ruby
# Workflow-YAML checker, run from ci.yml's required job AND from pr-guard.yml.
#
# Why it exists (#107): a workflow file that does not parse produces ZERO jobs, so it reports no
# check at all - the PR shows nothing where a verdict should be, and an admin merge (which is what
# `gh pr merge --admin` always is: it bypasses branch protection rather than satisfying it) walks
# through the gap. The trap that caused it: a step `name:` gaining a colon-space, which a plain YAML
# scalar cannot carry, and the whole of ci.yml went inert while every visible check read green.
#
# Why it is in TWO workflows and not one: a guard cannot check the file it lives in. Put the step
# only in ci.yml and a broken ci.yml is invisible; put it only in pr-guard.yml and a broken
# pr-guard.yml is invisible. Invoked from both, each one reports the other breaking. That is only
# mutual coverage, so a third failure mode is also handled here: if the parser itself is missing or
# this file is deleted, that is a loud failure, never a silent pass.
#
# Parsing is necessary but not sufficient - a workflow can parse and still describe nothing that
# runs. So each job must declare runs-on and at least one step, and no step may be a mapping with
# neither run: nor uses:, which the runner skips while the job still passes.

require 'yaml'

files = []
i = 0
while i < ARGV.size
  a = ARGV[i]
  if a == '--dir'
    dir = ARGV[i + 1]
    if dir.nil?
      warn 'wfyaml.rb: --dir needs a directory'
      exit 2
    end
    files = Dir.glob(File.join(dir, '*.yml')).sort + Dir.glob(File.join(dir, '*.yaml')).sort
    if files.empty?
      warn "#{dir}: no workflow files found - a glob that matches nothing is a silent pass"
      exit 1
    end
    break
  elsif a.start_with?('--')
    warn "wfyaml.rb: unknown flag #{a}"
    exit 2
  elsif !File.exist?(a)
    warn "#{a}: no such file"
    exit 1
  else
    files << a
  end
  i += 1
end

if files.empty?
  warn 'usage: ruby tools/wfyaml.rb <file>... | --dir <dir>'
  exit 2
end

fail_any = false
files.each do |path|
  begin
    doc = YAML.load_file(path)
  rescue Psych::SyntaxError => e
    warn "#{path}: does not parse - #{e.message}"
    warn '  a workflow that does not parse produces ZERO jobs, so no check is reported at all'
    fail_any = true
    next
  rescue Psych::DisallowedClass, ArgumentError => e
    warn "#{path}: loaded but is not a plain mapping - #{e.class}: #{e.message}"
    fail_any = true
    next
  end
  jobs = doc.is_a?(Hash) ? (doc['jobs'] || {}) : {}
  if jobs.empty?
    warn "#{path}: parses but declares no jobs - it would produce zero checks"
    fail_any = true
    next
  end
  bad = nil
  jobs.each do |name, job|
    j = job || {}
    if j['runs-on'].nil? && j['uses'].nil?
      bad = "#{path}: job #{name} has no runs-on - it would never start"
      break
    end
    steps = j['steps']
    if j['uses'].nil? && (steps.nil? || steps.empty?)
      bad = "#{path}: job #{name} has no steps - it would pass without doing anything"
      break
    end
    next if steps.nil?

    # A step runs if it has a non-empty run: or a non-empty uses:. A mapping with neither - a name
    # and nothing else - is skipped by the runner while the job still reports success.
    bare = steps.each_with_index.select do |s, _|
      s.is_a?(Hash) && (s['run'].nil? || s['run'].to_s.strip.empty?) &&
        (s['uses'].nil? || s['uses'].to_s.strip.empty?)
    end.map { |_, idx| idx }
    next if bare.empty?

    bad = "#{path}: job #{name} step(s) #{bare.join(', ')} have no run: or uses: - skipped while the job passes"
    break
  end
  if bad
    warn bad
    fail_any = true
    next
  end
  puts "#{path}: #{jobs.size} job(s), #{jobs.values.sum { |j| (j['steps'] || []).size }} step(s) parse"
end

if fail_any
  warn 'WORKFLOW YAML IS BROKEN'
  exit 1
end
puts "all #{files.size} workflow file(s) parse and can run"
