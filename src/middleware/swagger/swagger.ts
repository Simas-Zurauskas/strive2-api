import swaggerJSDoc from 'swagger-jsdoc';
import { API_URL } from '@conf/env';
import { schemas } from './schemas';

const swaggerSpec = swaggerJSDoc({
  swaggerDefinition: {
    openapi: '3.0.0',
    info: {
      title: 'Strive API',
      version: '1.0.0',
    },
    servers: [{ url: API_URL }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas,
    },
  },
  apis: ['./src/controlers/**/*.ts'],
});

export default swaggerSpec;
