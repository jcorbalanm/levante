import { HfInference } from '@huggingface/inference';
import type {
  TextGenerationInput,
  TextGenerationOptions,
  TextToImageInput,
  TextToImageOptions,
  ImageTextToTextInput,
  ImageToImageInput,
  ImageToImageOptions,
  TextToVideoInput,
  TextToVideoOptions,
  TextToSpeechInput,
  TextToSpeechOptions
} from '../../../types/inference';
import { getLogger } from '../logging';

const logger = getLogger();

/**
 * Client for Hugging Face Inference API
 * Handles different inference tasks using the official HF SDK
 */
export class HFInferenceClient {
  private client: HfInference;

  constructor(token: string) {
    this.client = new HfInference(token);
    logger.aiSdk.debug('HFInferenceClient initialized');
  }

  /**
   * Text Generation: Generate text continuations
   * @param model - HF model ID (e.g., "meta-llama/Llama-2-7b-hf")
   * @param input - Prompt text
   * @param options - Generation parameters
   * @returns Generated text
   */
  async textGeneration(
    model: string,
    input: TextGenerationInput,
    options?: TextGenerationOptions
  ): Promise<string> {
    try {
      logger.aiSdk.debug('Text generation inference', { model, prompt: input.prompt.substring(0, 50) });

      const result = await this.client.textGeneration({
        model,
        inputs: input.prompt,
        parameters: options
      });

      const generatedText = typeof result === 'string' ? result : result.generated_text;

      logger.aiSdk.info('Text generation completed', {
        model,
        textLength: generatedText.length
      });

      return generatedText;
    } catch (error) {
      logger.aiSdk.error('Text generation failed', {
        model,
        error: error instanceof Error ? error.message : error
      });
      throw error;
    }
  }

  /**
   * Text-to-Image: Generate images from text prompts
   * @param model - HF model ID (e.g., "black-forest-labs/FLUX.1-dev")
   * @param input - Prompt and options
   * @returns Blob containing the generated image
   */
  async textToImage(
    model: string,
    input: TextToImageInput,
    options?: TextToImageOptions
  ): Promise<Blob> {
    try {
      logger.aiSdk.debug('Text-to-image inference', { model, prompt: input.prompt });

      const blob = await this.client.textToImage({
        model,
        inputs: input.prompt,
        parameters: options
      });

      logger.aiSdk.info('Text-to-image completed', {
        model,
        blobSize: blob.size,
        blobType: blob.type
      });

      return blob;
    } catch (error) {
      logger.aiSdk.error('Text-to-image failed', {
        model,
        error: error instanceof Error ? error.message : error
      });
      throw error;
    }
  }

  /**
   * Image-Text-to-Text: Multimodal models (vision + text)
   * @param model - HF model ID (e.g., "llava-hf/llava-1.5-7b-hf")
   * @param input - Image and optional text prompt
   * @returns Text response
   */
  async imageTextToText(
    model: string,
    input: ImageTextToTextInput
  ): Promise<string> {
    try {
      logger.aiSdk.debug('Image-text-to-text inference', { model, hasText: !!input.text });

      // For multimodal models, use imageToText with the image
      // The text prompt will be part of the API call if supported by the model
      const result = await this.client.imageToText({
        model,
        data: input.image,
        // @ts-ignore - SDK may not have full typing for all parameters
        parameters: input.text ? { prompt: input.text } : undefined
      });

      logger.aiSdk.info('Image-text-to-text completed', {
        model,
        textLength: result.generated_text.length
      });

      return result.generated_text;
    } catch (error) {
      logger.aiSdk.error('Image-text-to-text failed', {
        model,
        error: error instanceof Error ? error.message : error
      });
      throw error;
    }
  }

  /**
   * Image-to-Image: Transform or edit images
   * @param model - HF model ID (e.g., "lllyasviel/sd-controlnet-canny")
   * @param input - Source image and optional prompt
   * @param options - Transformation parameters
   * @returns Blob containing the transformed image
   */
  async imageToImage(
    model: string,
    input: ImageToImageInput,
    options?: ImageToImageOptions
  ): Promise<Blob> {
    try {
      logger.aiSdk.debug('Image-to-image inference', { model });

      const blob = await this.client.imageToImage({
        model,
        inputs: input.image,
        parameters: {
          ...options,
          prompt: input.prompt
        }
      });

      logger.aiSdk.info('Image-to-image completed', {
        model,
        blobSize: blob.size,
        blobType: blob.type
      });

      return blob;
    } catch (error) {
      logger.aiSdk.error('Image-to-image failed', {
        model,
        error: error instanceof Error ? error.message : error
      });
      throw error;
    }
  }

  /**
   * Text-to-Video: Generate videos from text
   * @param model - HF model ID (e.g., "damo-vilab/text-to-video-ms-1.7b")
   * @param input - Text prompt
   * @param options - Video generation parameters
   * @returns Blob containing the video
   */
  async textToVideo(
    model: string,
    input: TextToVideoInput,
    options?: TextToVideoOptions
  ): Promise<Blob> {
    try {
      logger.aiSdk.debug('Text-to-video inference', { model, text: input.text.substring(0, 50) });

      // @ts-ignore - textToVideo may not be in SDK types yet
      const blob = await this.client.textToVideo({
        model,
        inputs: input.text,
        parameters: options
      });

      logger.aiSdk.info('Text-to-video completed', {
        model,
        blobSize: blob.size,
        blobType: blob.type
      });

      return blob;
    } catch (error) {
      logger.aiSdk.error('Text-to-video failed', {
        model,
        error: error instanceof Error ? error.message : error
      });
      throw error;
    }
  }

  /**
   * Text-to-Speech: Generate audio from text
   * @param model - HF model ID (e.g., "facebook/mms-tts-eng")
   * @param input - Text to synthesize
   * @param options - Voice and speed options
   * @returns Blob containing the audio
   */
  async textToSpeech(
    model: string,
    input: TextToSpeechInput,
    options?: TextToSpeechOptions
  ): Promise<Blob> {
    try {
      logger.aiSdk.debug('Text-to-speech inference', { model, text: input.text.substring(0, 50) });

      const blob = await this.client.textToSpeech({
        model,
        inputs: input.text,
        // @ts-ignore - SDK types may not match perfectly
        parameters: options
      });

      logger.aiSdk.info('Text-to-speech completed', {
        model,
        blobSize: blob.size,
        blobType: blob.type
      });

      return blob;
    } catch (error) {
      logger.aiSdk.error('Text-to-speech failed', {
        model,
        error: error instanceof Error ? error.message : error
      });
      throw error;
    }
  }
}
