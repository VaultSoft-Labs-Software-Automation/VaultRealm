// Runs a script on the Lightsail server using the Jenkins credentials
def remote(String script) {
    withCredentials([
        sshUserPrivateKey(credentialsId: 'lightsail-ssh',
                          keyFileVariable: 'SSH_KEY',
                          usernameVariable: 'SSH_USER'),
        string(credentialsId: 'lightsail-host', variable: 'SSH_HOST')
    ]) {
        writeFile file: 'remote.sh', text: script
        sh '''
            ssh -i "$SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new \
                "$SSH_USER@$SSH_HOST" 'bash -s' < remote.sh
        '''
    }
}

pipeline {
    agent any

    options {
        timestamps()
        disableConcurrentBuilds()
        timeout(time: 30, unit: 'MINUTES')
    }

    stages {
        stage('Checkout') {
            steps { checkout scm }
        }

        stage('Deploy') {
            when { branch 'main' }
            steps {
                script {
                    remote('''
                        set -euo pipefail
                        APP_DIR=/opt/vaultrealm

                        if [ ! -d "$APP_DIR/.git" ]; then
                          git clone git@github.com:HypertextAssassinRajith/VaultRealm.git "$APP_DIR"
                        fi

                        cd "$APP_DIR"
                        git fetch origin main
                        git reset --hard origin/main

                        docker compose up -d --build --remove-orphans
                        docker image prune -f
                    ''')
                }
            }
        }

        stage('Health check') {
            when { branch 'main' }
            steps {
                script {
                    remote('''
                        set -u
                        cd /opt/vaultrealm
                        for i in $(seq 1 12); do
                          if docker compose exec -T panel wget -qO- http://localhost:3001/healthz >/dev/null 2>&1; then
                            echo "Healthy"; exit 0
                          fi
                          sleep 5
                        done
                        echo "Health check failed"; exit 1
                    ''')
                }
            }
        }
    }

    post {
        success { echo 'Deployed successfully.' }
        failure { echo 'Deploy failed, check the console output.' }
    }
}