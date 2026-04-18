/**
 * Test Targets - OSINT Agent Test Scenarios
 *
 * This file contains real or realistic test targets that can be used
 * to test the agent.
 *
 * NOTE: Those marked as "ethical" are real people whose
 * information is already public. Others are fictional/for testing only.
 */

export interface TestTarget {
  id: string
  description: string
  type: 'real_public' | 'fictional' | 'test_account'
  ethical: boolean  // Is this a real person? (from an ethical standpoint)
  data: {
    username?: string
    email?: string
    name?: string
    platforms?: string[]
    expectedFindings?: string[]
  }
  difficulty: 'easy' | 'medium' | 'hard'
}

/**
 * SAFE TEST TARGETS
 * These targets are safe for testing; information is publicly available
 */
export const SAFE_TEST_TARGETS: TestTarget[] = [
  {
    id: 'octocat',
    description: 'GitHub official mascot account - Most basic test',
    type: 'real_public',
    ethical: true,
    difficulty: 'easy',
    data: {
      username: 'octocat',
      name: 'The Octocat',
      platforms: ['GitHub'],
      expectedFindings: [
        'GitHub profili: https://github.com/octocat',
        'Email: octocat@github.com (profile)',
        '8 public repo',
        'GPG/SSH keys possible'
      ]
    }
  },
  {
    id: 'torvalds',
    description: 'Linus Torvalds - Linux creator (very active, lots of data)',
    type: 'real_public',
    ethical: true,
    difficulty: 'easy',
    data: {
      username: 'torvalds',
      name: 'Linus Torvalds',
      email: 'torvalds@linux-foundation.org',
      platforms: ['GitHub', 'Twitter', 'Linux Foundation'],
      expectedFindings: [
        'GitHub: https://github.com/torvalds',
        'Linux kernel commit emailleri',
        'Many cross-references'
      ]
    }
  },
  {
    id: 'defunkt',
    description: 'Chris Wanstrath - GitHub co-founder (not active but data exists)',
    type: 'real_public',
    ethical: true,
    difficulty: 'medium',
    data: {
      username: 'defunkt',
      platforms: ['GitHub', 'Twitter', 'Blog'],
      expectedFindings: [
        'Eski GitHub aktiviteleri',
        'Twitter cross-reference',
        'Blog: https://chriswanstrath.com/'
      ]
    }
  }
]

/**
 * FICTIONAL TEST SCENARIOS
 * These scenarios are completely fictional, entirely safe from an ethical standpoint
 */
export const FICTIONAL_SCENARIOS: TestTarget[] = [
  {
    id: 'scenario_1_simple',
    description: 'Simple: Single username, open profile',
    type: 'fictional',
    ethical: false,
    difficulty: 'easy',
    data: {
      username: 'demo_user_2024',
      email: 'demo_user_2024@example.com',
      name: 'Demo User',
      platforms: ['GitHub', 'Twitter', 'LinkedIn'],
      expectedFindings: [
        'Same username on 3 platforms',
        'Open email address',
        'Profile photo can be cross-referenced'
      ]
    }
  },
  {
    id: 'scenario_2_network',
    description: 'Medium: Multiple linked accounts (network test)',
    type: 'fictional',
    ethical: false,
    difficulty: 'medium',
    data: {
      username: 'network_test_alpha',
      email: 'alpha@test-network.example',
      name: 'Alpha Tester',
      platforms: ['GitHub', 'GitLab', 'Twitter', 'Reddit'],
      expectedFindings: [
        'Same email on 4 platforms',
        'GitHub link in Twitter bio',
        'Twitter mention in GitHub repo',
        'Ideal for network graph testing'
      ]
    }
  },
  {
    id: 'scenario_3_hard',
    description: 'Hard: Hidden/private account, minimal trace',
    type: 'fictional',
    ethical: false,
    difficulty: 'hard',
    data: {
      username: 'ghost_user_x7',
      platforms: ['GitHub (private)', 'Twitter (protected)', 'Forum'],
      expectedFindings: [
        'Very little open data',
        'Only old commit emails',
        'Wayback Machine archive'
      ]
    }
  }
]

/**
 * GITHUB API TEST CASES
 */
export const GITHUB_TEST_CASES = {
  // Existing users
  existing: [
    'octocat',      // GitHub mascot
    'torvalds',     // Linus
    'defunkt',      // Chris Wanstrath
    'gaearon',      // Dan Abramov
    'sindresorhus'  // Active open source developer
  ],
  
  // Non-existent users
  nonexistent: [
    'this_user_does_not_exist_xyz',
    'nonexistent_user_12345_test'
  ]
}

/**
 * Neo4j Graph Test Data
 * Sample graph for integration tests
 */
export const NEO4J_TEST_GRAPH = {
  nodes: [
    { label: 'Username', value: 'test_subject' },
    { label: 'Email', value: 'test@example.com' },
    { label: 'Person', value: 'Test User' },
    { label: 'Profile', value: 'https://github.com/test_subject', platform: 'GitHub' },
    { label: 'Profile', value: 'https://twitter.com/test_subject', platform: 'Twitter' },
    { label: 'Location', value: 'Istanbul' }
  ],
  relationships: [
    { from: 'test_subject', to: 'test@example.com', type: 'USES_EMAIL' },
    { from: 'test_subject', to: 'Test User', type: 'REAL_NAME' },
    { from: 'test_subject', to: 'https://github.com/test_subject', type: 'HAS_PROFILE' },
    { from: 'test_subject', to: 'https://twitter.com/test_subject', type: 'HAS_PROFILE' },
    { from: 'test_subject', to: 'Istanbul', type: 'LOCATED_IN' }
  ]
}

/**
 * Agent Test Scenarios
 * Scenarios for full flow testing
 */
export const AGENT_TEST_SCENARIOS = [
  {
    name: 'Simple Username Search',
    steps: [
      'User: "find info about octocat"',
      'Agent: runs Sherlock',
      'Agent: runs GitHub API',
      'Agent: writes info to graph',
      'Agent: presents summary report'
    ]
  },
  {
    name: 'Email-Based Research',
    steps: [
      'User: "who owns test@example.com?"',
      'Agent: runs holehe (mock)',
      'Agent: reports found platforms'
    ]
  },
  {
    name: 'Network Analysis',
    steps: [
      'User: "what is the connection between these users?"',
      'Agent: researches both users',
      'Agent: finds shared connections (email, location, etc)',
      'Agent: visualizes network graph'
    ]
  }
]
